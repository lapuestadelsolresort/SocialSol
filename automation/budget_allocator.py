#!/usr/bin/env python3
"""Plan resort Meta spend from the optimizer budget cap.

The allocator writes planned rows into budget_ledger. It never talks to Meta.
meta_budget_sync.py is the only script allowed to push budgets, and it refuses
live writes until smoke-test keys are recorded.
"""

import argparse
import json
import os
import sqlite3
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
ACTIVE_CAMPAIGNS = os.path.join(ROOT, "campaigns", "active-campaigns.json")

BUCKETS = ["reach", "engagement", "leads"]
DEFAULT_SPLIT = {"reach": 0.35, "engagement": 0.35, "leads": 0.30}
QUALIFIED = "(max_scroll_pct > 0 OR reached_cta = 1 OR dwell_ms >= 10000)"
NOT_BOT = "is_bot=0"


def ensure_tables(con):
    con.execute(
        "CREATE TABLE IF NOT EXISTS budget_ledger ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, bucket TEXT NOT NULL, "
        "variant_id INTEGER, meta_object_id TEXT, planned_spend REAL DEFAULT 0, "
        "actual_spend REAL DEFAULT 0, sessions INTEGER DEFAULT 0, qualified_sessions INTEGER DEFAULT 0, "
        "cta_views INTEGER DEFAULT 0, cta_clicks INTEGER DEFAULT 0, leads INTEGER DEFAULT 0, "
        "bookings INTEGER DEFAULT 0, reconciled_at TEXT)"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS decisions ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')), "
        "pass_id TEXT, actor TEXT DEFAULT 'optimizer', action TEXT NOT NULL, target_kind TEXT, "
        "target_id TEXT, before TEXT, after TEXT, rationale TEXT)"
    )


def load_cfg(con):
    cfg = {}
    try:
        for key, value in con.execute("SELECT key, value FROM optimizer_config").fetchall():
            try:
                cfg[key] = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                cfg[key] = value
    except sqlite3.OperationalError:
        pass
    return cfg


def ramped_split(cfg, today=None):
    start = cfg.get("bucket_split", DEFAULT_SPLIT)
    ramp = cfg.get("bucket_split_ramp") or {}
    target = ramp.get("target", start)
    weeks = float(ramp.get("weeks", 0) or 0)
    started = cfg.get("bucket_split_started_at")
    if weeks <= 0 or not started:
        return normalize(start)
    try:
        start_date = datetime.strptime(started, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return normalize(start)
    today = today or date.today()
    progress = max(0.0, min(1.0, (today - start_date).days / (weeks * 7.0)))
    cur = {b: start.get(b, 0) + (target.get(b, 0) - start.get(b, 0)) * progress for b in BUCKETS}
    return normalize(cur)


def normalize(split):
    total = sum(max(0.0, split.get(b, 0)) for b in BUCKETS) or 1.0
    return {b: max(0.0, split.get(b, 0)) / total for b in BUCKETS}


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


def q1(con, sql, params=()):
    try:
        row = con.execute(sql, params).fetchone()
        return row[0] if row and row[0] is not None else 0
    except sqlite3.OperationalError:
        return 0


def campaign_mean(con, bucket, record):
    tags = campaign_tags(record)
    if not tags:
        return 0.5
    ph = ",".join("?" for _ in tags)
    sessions = q1(con, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND utm_campaign IN ({ph})", tags)
    qualified = q1(con, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND utm_campaign IN ({ph}) AND {QUALIFIED}", tags)
    cta_clicks = q1(con, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND utm_campaign IN ({ph}) AND cta_clicked=1", tags)
    leads = q1(con, f"SELECT COUNT(DISTINCT lead_id) FROM attribution_events WHERE event_type='whatsapp_lead' AND utm_campaign IN ({ph})", tags)
    if bucket == "reach":
        success, exposure = qualified, sessions
    elif bucket == "engagement":
        cta_views = q1(con, f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND utm_campaign IN ({ph}) AND reached_cta=1", tags)
        success, exposure = cta_views, sessions
    else:
        success, exposure = leads, qualified or sessions
    return (success + 1.0) / (max(exposure - success, 0) + success + 2.0)


def meta_arms(con, bucket):
    records = load_json(ACTIVE_CAMPAIGNS, [])
    if not isinstance(records, list):
        return []
    arms = []
    for rec in records:
        if rec.get("status") != "ACTIVE" or not rec.get("adset_id"):
            continue
        if (rec.get("bucket") or "leads") != bucket:
            continue
        adset_id = str(rec["adset_id"])
        arms.append({
            "key": f"meta:{adset_id}",
            "kind": "meta_adset",
            "slug": rec.get("brief_id") or rec.get("campaign_name") or adset_id,
            "arm_id": None,
            "meta_object_id": adset_id,
            "mean": campaign_mean(con, bucket, rec),
        })
    return arms


def lp_arms(con, bucket):
    try:
        rows = con.execute(
            "SELECT a.arm_id, a.slug, a.alpha, a.beta, v.meta_object_id "
            "FROM bandit_arms a JOIN lp_variants v ON v.id = a.arm_id "
            "WHERE a.bucket=? AND v.status='live'",
            (bucket,),
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    arms = []
    for arm_id, slug, alpha, beta, meta_object_id in rows:
        mean = (alpha or 1.0) / ((alpha or 1.0) + (beta or 1.0))
        arms.append({
            "key": f"lp:{arm_id}",
            "kind": "lp_variant",
            "slug": slug,
            "arm_id": arm_id,
            "meta_object_id": meta_object_id,
            "mean": mean,
        })
    return arms


def bucket_arms(con, bucket):
    return meta_arms(con, bucket) or lp_arms(con, bucket)


def distribute(amount, arms, floor_share):
    if not arms or amount <= 0:
        return {}
    total = sum(a["mean"] for a in arms) or 1.0
    shares = {a["key"]: a["mean"] / total for a in arms}
    floor = floor_share / len(arms)
    shares = {k: max(v, floor) for k, v in shares.items()}
    norm = sum(shares.values()) or 1.0
    return {k: amount * (v / norm) for k, v in shares.items()}


def allocate(con, today=None, dry_run=False, pass_id="manual"):
    ensure_tables(con)
    cfg = load_cfg(con)
    cap = float(cfg.get("budget_cap_daily", 0) or 0)
    pause_all = bool(cfg.get("pause_all", False))
    floor = float(cfg.get("exploration_floor_share", 0.15))
    today = today or date.today()
    today_s = today.isoformat()

    if cap <= 0 or pause_all:
        reason = "budget_cap=0" if cap <= 0 else "pause_all=true"
        return {"date": today_s, "cap": cap, "killed": True, "reason": reason, "plan": []}

    split = ramped_split(cfg, today)
    plan = []
    for bucket in BUCKETS:
        bucket_budget = round(cap * split[bucket], 2)
        arms = bucket_arms(con, bucket)
        if not arms:
            plan.append({"bucket": bucket, "arm_id": None, "slug": None,
                         "planned_spend": bucket_budget, "note": "no_live_arms"})
            continue
        allocations = distribute(bucket_budget, arms, floor)
        for arm_key, amount in allocations.items():
            arm = next(a for a in arms if a["key"] == arm_key)
            plan.append({
                "bucket": bucket,
                "arm_id": arm.get("arm_id"),
                "arm_key": arm_key,
                "slug": arm["slug"],
                "target_kind": arm.get("kind"),
                "meta_object_id": arm.get("meta_object_id"),
                "planned_spend": round(amount, 2),
                "note": None,
            })
        idxs = [i for i, p in enumerate(plan) if p["bucket"] == bucket and p.get("planned_spend", 0) > 0]
        delta = round(bucket_budget - sum(plan[i]["planned_spend"] for i in idxs), 2)
        if idxs and abs(delta) >= 0.01:
            plan[idxs[-1]]["planned_spend"] = round(plan[idxs[-1]]["planned_spend"] + delta, 2)

    if not dry_run:
        con.execute("DELETE FROM budget_ledger WHERE date=? AND (actual_spend=0 OR actual_spend IS NULL)", (today_s,))
        for row in plan:
            con.execute(
                "INSERT INTO budget_ledger (date, bucket, variant_id, meta_object_id, planned_spend) "
                "VALUES (?, ?, ?, ?, ?)",
                (today_s, row["bucket"], row["arm_id"], row.get("meta_object_id"), row["planned_spend"]),
            )
        con.execute(
            "INSERT INTO decisions (pass_id, actor, action, target_kind, target_id, after, rationale) "
            "VALUES (?, 'allocator', 'allocate', 'budget', ?, ?, ?)",
            (
                pass_id,
                today_s,
                json.dumps({b: round(cap * split[b], 2) for b in BUCKETS}),
                f"cap=${cap} split={ {b: round(split[b], 3) for b in BUCKETS} }",
            ),
        )
        con.commit()

    return {"date": today_s, "cap": cap, "killed": False,
            "split": {b: round(split[b], 3) for b in BUCKETS}, "plan": plan}


def main():
    ap = argparse.ArgumentParser(description="Allocate the resort optimizer daily budget")
    ap.add_argument("--date", help="Override today as YYYY-MM-DD")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pass-id", dest="pass_id", default="manual")
    args = ap.parse_args()

    today = datetime.strptime(args.date, "%Y-%m-%d").date() if args.date else None
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.execute("PRAGMA busy_timeout=15000")
    try:
        result = allocate(con, today=today, dry_run=args.dry_run, pass_id=args.pass_id)
    finally:
        con.close()

    if result["killed"]:
        print(f"budget_allocator: KILL SWITCH active ({result['reason']}) - $0 planned for {result['date']}")
        return
    print(f"budget_allocator: cap ${result['cap']}/day split {result['split']}{' [dry-run]' if args.dry_run else ''}")
    for row in result["plan"]:
        target = row["slug"] or f"({row['note']})"
        print(f"  {row['bucket']:<11} ${row['planned_spend']:>6.2f}  {target}")


if __name__ == "__main__":
    main()
