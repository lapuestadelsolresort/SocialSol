#!/usr/bin/env python3
"""Campaign and UTM integrity snapshot for the resort optimizer.

Read-only. It checks active paid campaign records, live LP variants, experiment
links, tracking volume, and weight groups. The output is JSON so a cron or Slack
report can decide what to propose without changing campaign state.
"""

import argparse
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

from campaign_registry import apply_snapshot, fetch_live_snapshot, load_registry

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
CAMPAIGNS_PATH = os.path.join(ROOT, "campaigns", "active-campaigns.json")
VARIANTS_DIR = os.path.join(ROOT, "lp", "variants")

QUALIFIED = "(max_scroll_pct > 0 OR reached_cta = 1 OR dwell_ms >= 10000)"
NOT_BOT = "is_bot=0"


def la_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:
        return datetime.now(timezone(timedelta(hours=-7)))


def ro_conn():
    if not os.path.exists(DB_PATH):
        return None
    try:
        return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    except sqlite3.Error:
        return None


def q1(cur, sql, params=()):
    if not cur:
        return 0
    try:
        cur.execute(sql, params)
        row = cur.fetchone()
        return row[0] if row and row[0] is not None else 0
    except sqlite3.Error:
        return 0


def qall(cur, sql, params=()):
    if not cur:
        return []
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    except sqlite3.Error:
        return []


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def campaign_tags(record):
    tags = set()
    if record.get("utm_campaign"):
        tags.add(str(record["utm_campaign"]))
    for alias in record.get("utm_aliases") or []:
        if alias:
            tags.add(str(alias))
    for destination in record.get("destinations") or []:
        if destination.get("utm_campaign"):
            tags.add(str(destination["utm_campaign"]))
    return sorted(tags)


def experiments_index(cur):
    by_variant, by_utm, by_campaign = {}, {}, {}
    for slug, linked_variant, linked_utm, linked_campaign in qall(
        cur,
        "SELECT slug, linked_variant_slug, linked_utm_campaign, linked_campaign_id "
        "FROM experiments WHERE status IN ('running','proposed')",
    ):
        if linked_variant:
            by_variant[linked_variant] = slug
        if linked_utm:
            by_utm[str(linked_utm)] = slug
        if linked_campaign:
            by_campaign[str(linked_campaign)] = slug
    return by_variant, by_utm, by_campaign


def load_campaigns(cur):
    records = load_registry(CAMPAIGNS_PATH)
    if records:
        return apply_snapshot(records, fetch_live_snapshot(records), datetime.now(timezone.utc).isoformat())
    db_rows = qall(
        cur,
        "SELECT name, status, budget_daily, meta_campaign_id FROM campaigns WHERE status='active' OR status='ACTIVE'",
    )
    for name, status, budget, meta_campaign_id in db_rows:
        if meta_campaign_id and not any(str(r.get("campaign_id")) == str(meta_campaign_id) for r in records):
            records.append({
                "campaign_name": name,
                "status": "ACTIVE" if str(status).lower() == "active" else status,
                "daily_budget_usd": budget,
                "campaign_id": str(meta_campaign_id),
                "utm_campaign": str(meta_campaign_id),
            })
    return records


def check_campaigns(cur, cutoff, gaps):
    out = []
    _, by_utm, by_campaign = experiments_index(cur)
    grouped = {}
    for rec in load_campaigns(cur):
        if rec.get("status") != "ACTIVE":
            continue
        key = str(rec.get("campaign_id") or rec.get("campaign_name") or rec.get("brief_id"))
        if key not in grouped:
            grouped[key] = dict(rec)
            grouped[key]["_records"] = [rec]
        else:
            grouped[key]["_records"].append(rec)

    for rec in grouped.values():
        cid = str(rec.get("campaign_id") or "")
        records = rec.pop("_records")
        tags = sorted({tag for item in records for tag in campaign_tags(item)})
        exp = rec.get("experiment_slug") or by_campaign.get(cid)
        for tag in tags:
            exp = exp or by_utm.get(tag)
        issues = []
        if not exp:
            issues.append("no_linked_experiment")
            gaps.append({
                "type": "campaign_unlinked",
                "target": cid or rec.get("campaign_name"),
                "detail": "ACTIVE campaign has no experiment linked by campaign id or UTM",
                "auto_fixable": True,
            })
        if tags:
            ph = ",".join("?" for _ in tags)
            sessions = q1(cur, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND utm_campaign IN ({ph}) AND created_at>=?", (*tags, cutoff))
            qualified = q1(cur, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND utm_campaign IN ({ph}) AND created_at>=? AND {QUALIFIED}", (*tags, cutoff))
            cta_clicks = q1(cur, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND utm_campaign IN ({ph}) AND created_at>=? AND cta_clicked=1", (*tags, cutoff))
            leads = q1(cur, f"SELECT COUNT(DISTINCT lead_id) FROM attribution_events WHERE event_type='whatsapp_lead' AND utm_campaign IN ({ph}) AND created_at>=?", (*tags, cutoff))
        else:
            sessions = qualified = cta_clicks = leads = 0
            issues.append("no_utm_tags")
        if sessions == 0:
            issues.append("no_sessions_in_window")
            gaps.append({
                "type": "campaign_no_sessions",
                "target": cid or rec.get("campaign_name"),
                "detail": "ACTIVE campaign has no CRM page_sessions in the window",
                "auto_fixable": False,
            })
        out.append({
            "campaign_id": cid,
            "name": rec.get("campaign_name") or rec.get("brief_id"),
            "daily_budget_usd": rec.get("campaign_daily_budget_usd", rec.get("daily_budget_usd")),
            "budget_level": rec.get("budget_level") or "adset",
            "adsets": [str(item.get("adset_id")) for item in records if item.get("adset_id")],
            "utm_tags": tags,
            "linked_experiment": exp,
            "sessions": sessions,
            "qualified": qualified,
            "whatsapp_clicks": cta_clicks,
            "leads": leads,
            "issues": issues,
        })
    return out


def check_variants(cur, cutoff, gaps):
    out = []
    db_variants = {}
    for slug, page, lang, source, audience, weight, status in qall(
        cur,
        "SELECT slug, page_slug, language, source, audience, traffic_weight, status FROM lp_variants",
    ):
        db_variants[slug] = {
            "page_slug": page,
            "language": lang,
            "source": source,
            "audience": audience,
            "weight": weight,
            "status": status,
        }
    by_variant, _, _ = experiments_index(cur)

    file_variants = {}
    if os.path.isdir(VARIANTS_DIR):
        for fn in os.listdir(VARIANTS_DIR):
            if not fn.endswith(".json"):
                continue
            data = load_json(os.path.join(VARIANTS_DIR, fn), {})
            if data.get("slug"):
                file_variants[data["slug"]] = data

    groups = {}
    for slug, data in db_variants.items():
        if data["status"] != "live":
            continue
        groups.setdefault((data["page_slug"], data["language"], data["source"], data["audience"]), []).append((slug, data["weight"]))

    for slug, data in db_variants.items():
        if data["status"] != "live":
            continue
        exp = by_variant.get(slug)
        sessions = q1(
            cur,
            "SELECT COUNT(*) FROM page_sessions ps JOIN lp_variants v ON v.id=ps.variant_id "
            f"WHERE ps.{NOT_BOT} AND v.slug=? AND ps.created_at>=?",
            (slug, cutoff),
        )
        clicks = q1(
            cur,
            "SELECT COUNT(*) FROM page_sessions ps JOIN lp_variants v ON v.id=ps.variant_id "
            f"WHERE ps.{NOT_BOT} AND v.slug=? AND ps.created_at>=? AND ps.cta_clicked=1",
            (slug, cutoff),
        )
        issues = []
        if not exp:
            issues.append("no_linked_experiment")
            gaps.append({
                "type": "variant_unlinked",
                "target": slug,
                "detail": f"live variant {slug} has no experiment",
                "auto_fixable": True,
            })
        if slug not in file_variants:
            issues.append("not_mirrored_to_file")
            gaps.append({
                "type": "variant_no_file",
                "target": slug,
                "detail": f"live variant {slug} has no lp/variants/{slug}.json mirror",
                "auto_fixable": True,
            })
        elif file_variants[slug].get("status") != data["status"]:
            issues.append("file_status_mismatch")
        out.append({
            "slug": slug,
            "page_slug": data["page_slug"],
            "language": data["language"],
            "weight": data["weight"],
            "linked_experiment": exp,
            "sessions": sessions,
            "whatsapp_clicks": clicks,
            "issues": issues,
        })

    weights = []
    for (page, lang, source, audience), members in groups.items():
        total = sum(weight or 0 for _, weight in members)
        entry = {
            "group": {"page_slug": page, "language": lang, "source": source, "audience": audience},
            "total_weight": total,
            "members": [{"slug": slug, "weight": weight} for slug, weight in members],
        }
        if total <= 0:
            entry["issue"] = "zero_total_weight"
            gaps.append({
                "type": "weight_group_zero",
                "target": f"{page}/{lang}/{source}/{audience}",
                "detail": "live variant group has total traffic_weight 0",
                "auto_fixable": False,
            })
        weights.append(entry)
    return out, weights


def check_instrumentation(cur, cutoff):
    events = q1(cur, "SELECT COUNT(*) FROM page_events WHERE ts>=?", (cutoff,))
    pageviews = q1(cur, "SELECT COUNT(*) FROM page_events WHERE kind='pageview' AND ts>=?", (cutoff,))
    wa_clicks = q1(cur, "SELECT COUNT(*) FROM page_events WHERE kind='wa_click' AND ts>=?", (cutoff,))
    sessions = q1(cur, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND created_at>=?", (cutoff,))
    return {
        "tracker": {
            "sessions_in_window": sessions,
            "events_in_window": events,
            "pageviews": pageviews,
            "wa_clicks": wa_clicks,
            "ok": events > 0 and sessions > 0,
        }
    }


def check_due(cur, today_str):
    due = []
    for slug, review_at, metric in qall(
        cur,
        "SELECT slug, review_at, primary_metric FROM experiments "
        "WHERE status='running' AND review_at IS NOT NULL AND review_at<=? ORDER BY review_at",
        (today_str,),
    ):
        due.append({"slug": slug, "review_at": review_at, "primary_metric": metric})
    return due


def main():
    ap = argparse.ArgumentParser(description="Resort campaign and UTM integrity report")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    now = la_now()
    today_str = now.strftime("%Y-%m-%d")
    local_cutoff = (now - timedelta(days=args.days)).replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = local_cutoff.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    con = ro_conn()
    cur = con.cursor() if con else None
    gaps = []
    campaigns = check_campaigns(cur, cutoff, gaps)
    variants, weights = check_variants(cur, cutoff, gaps)
    due = check_due(cur, today_str)
    instrumentation = check_instrumentation(cur, cutoff)
    running = q1(cur, "SELECT COUNT(*) FROM experiments WHERE status='running'")
    if con:
        con.close()

    snapshot = {
        "generated_at": now.isoformat(),
        "window_days": args.days,
        "db_present": con is not None,
        "summary": {
            "active_meta_campaigns": len(campaigns),
            "active_campaign_records": len([r for r in load_campaigns(None) if r.get("status") == "ACTIVE"]),
            "live_variants": len(variants),
            "running_experiments": running,
            "reviews_due": len(due),
            "gaps": len(gaps),
            "auto_fixable_gaps": sum(1 for gap in gaps if gap.get("auto_fixable")),
        },
        "campaigns": campaigns,
        "variants": variants,
        "weight_groups": weights,
        "experiments_due": due,
        "instrumentation": instrumentation,
        "gaps": gaps,
    }
    print(json.dumps(snapshot, indent=2 if args.pretty else None))


if __name__ == "__main__":
    main()
