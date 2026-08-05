#!/usr/bin/env python3
"""Safety guardrails for the resort optimizer.

The guardrails never edit Meta campaign state. On-site rollbacks are limited to
variant status/weight changes through apply_variant.py. Spend-side problems are
reported for Slack/operator action unless Meta sync has passed its smoke gates.
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
APPLY_VARIANT = os.path.join(HERE, "apply_variant.py")

QUALIFIED = "(max_scroll_pct > 0 OR reached_cta = 1 OR dwell_ms >= 10000)"
NOT_BOT = "is_bot=0"


def ensure_tables(con):
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


def _apply_status(slug, status, reason, dry_run):
    if dry_run:
        return True, f"[dry-run] would set {slug} status={status}"
    try:
        out = subprocess.run(
            [sys.executable, APPLY_VARIANT, "status", slug, status, "--reason", reason],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return True, (out.stdout.strip().splitlines() or ["applied"])[0]
    except subprocess.CalledProcessError as e:
        return False, f"apply_variant failed: {e.stderr.strip()}"


def _decision(con, pass_id, action, kind, target, before, after, rationale, actor="guardrails"):
    con.execute(
        "INSERT INTO decisions (pass_id, actor, action, target_kind, target_id, before, after, rationale) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            pass_id,
            actor,
            action,
            kind,
            target,
            json.dumps(before) if before is not None else None,
            json.dumps(after) if after is not None else None,
            rationale,
        ),
    )


def detect_breakers(con, cfg=None, today=None):
    cfg = cfg or load_cfg(con)
    ceilings = cfg.get("ceilings", {})
    zero_click_pause = float(ceilings.get("zero_click_spend_pause", 35.0))
    cpwc_max = float(ceilings.get("cost_per_whatsapp_click_max", 45.0))
    today_s = (today or date.today()).isoformat()
    out = []
    try:
        rows = con.execute(
            "SELECT bucket, variant_id, meta_object_id, actual_spend, cta_clicks, leads, bookings "
            "FROM budget_ledger WHERE date=?",
            (today_s,),
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    for bucket, variant_id, meta_object_id, spend, cta_clicks, leads, bookings in rows:
        spend = float(spend or 0)
        cta_clicks = int(cta_clicks or 0)
        leads = int(leads or 0)
        bookings = int(bookings or 0)
        if spend >= zero_click_pause and cta_clicks == 0 and leads == 0 and bookings == 0:
            out.append({
                "bucket": bucket,
                "variant_id": variant_id,
                "meta_object_id": meta_object_id,
                "reason": f"${spend:.2f} spent with 0 WhatsApp clicks, leads, or bookings",
            })
        elif cta_clicks > 0 and (spend / cta_clicks) > cpwc_max:
            out.append({
                "bucket": bucket,
                "variant_id": variant_id,
                "meta_object_id": meta_object_id,
                "reason": f"cost per WhatsApp click ${spend / cta_clicks:.2f} > ${cpwc_max:.2f}",
            })
    return out


def kill_switch(con, pass_id="manual", dry_run=False):
    if not dry_run:
        ensure_tables(con)
    cfg = load_cfg(con)
    cap = float(cfg.get("budget_cap_daily", 0) or 0)
    pause_all = bool(cfg.get("pause_all", False))
    if cap > 0 and not pause_all:
        return {"active": False, "paused": []}

    reason = "budget_cap=0" if cap <= 0 else "pause_all=true"
    rows = con.execute("SELECT slug FROM lp_variants WHERE status='live' AND created_by='agent'").fetchall()
    paused = []
    for (slug,) in rows:
        ok, msg = _apply_status(slug, "paused", f"kill switch: {reason}", dry_run)
        if ok and not dry_run:
            _decision(con, pass_id, "pause", "lp_variant", slug, "live", "paused", f"kill switch: {reason}")
        paused.append((slug, msg))
    if not dry_run:
        con.commit()
    return {"active": True, "reason": reason, "paused": paused}


def auto_rollback(con, pass_id="manual", dry_run=False):
    if not dry_run:
        ensure_tables(con)
    cfg = load_cfg(con)
    window = int(cfg.get("rollback_window_sessions", 150))
    reverted = []
    groups = {}
    for variant_id, slug, page, lang, source, audience, weight, created_by in con.execute(
        "SELECT id, slug, page_slug, language, source, audience, traffic_weight, created_by "
        "FROM lp_variants WHERE status='live'"
    ).fetchall():
        groups.setdefault((page, lang, source, audience), []).append({
            "id": variant_id,
            "slug": slug,
            "weight": weight or 0,
            "agent": created_by == "agent",
        })

    for _key, arms in groups.items():
        if len(arms) < 2:
            continue
        stats = {}
        for arm in arms:
            qualified = con.execute(
                f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND variant_id=? AND {QUALIFIED}",
                (arm["id"],),
            ).fetchone()[0] or 0
            clicks = con.execute(
                f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND variant_id=? AND ({QUALIFIED}) AND cta_clicked=1",
                (arm["id"],),
            ).fetchone()[0] or 0
            stats[arm["id"]] = {"qualified": qualified, "rate": (clicks / qualified) if qualified else 0.0}

        controls = [arm for arm in arms if not arm["agent"]] or arms
        control = max(controls, key=lambda arm: stats[arm["id"]]["qualified"])
        control_rate = stats[control["id"]]["rate"]
        for arm in arms:
            if not arm["agent"] or arm["id"] == control["id"]:
                continue
            st = stats[arm["id"]]
            if st["qualified"] < window or st["rate"] >= control_rate * 0.8:
                continue
            try:
                row = con.execute(
                    "SELECT before FROM decisions WHERE target_id=? AND action='reweight' ORDER BY id DESC LIMIT 1",
                    (arm["slug"],),
                ).fetchone()
            except sqlite3.OperationalError:
                row = None
            before_weight = None
            if row and row[0] is not None:
                try:
                    before_weight = int(json.loads(row[0]))
                except (TypeError, ValueError, json.JSONDecodeError):
                    before_weight = None
            if before_weight is None or before_weight == arm["weight"]:
                continue
            if not dry_run:
                subprocess.run(
                    [sys.executable, APPLY_VARIANT, "weight", arm["slug"], str(before_weight),
                     "--reason", "auto-rollback: WhatsApp-click rate regressed vs control"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                _decision(
                    con,
                    pass_id,
                    "rollback",
                    "lp_variant",
                    arm["slug"],
                    arm["weight"],
                    before_weight,
                    f"click-rate {st['rate']:.3f} < 0.8*control {control_rate:.3f} over {st['qualified']} qualified",
                )
            reverted.append({
                "slug": arm["slug"],
                "from": arm["weight"],
                "to": before_weight,
                "rate": round(st["rate"], 3),
                "control_rate": round(control_rate, 3),
            })
    if not dry_run:
        con.commit()
    return reverted


def main():
    ap = argparse.ArgumentParser(description="Run resort optimizer guardrails")
    ap.add_argument("check", choices=["breakers", "kill", "rollback", "all"], default="all", nargs="?")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pass-id", dest="pass_id", default="manual")
    args = ap.parse_args()

    con = sqlite3.connect(DB_PATH, timeout=15)
    con.execute("PRAGMA busy_timeout=15000")
    try:
        if args.check in ("kill", "all"):
            ks = kill_switch(con, args.pass_id, args.dry_run)
            if ks["active"]:
                print(f"guardrails: KILL SWITCH ({ks['reason']}) - paused {len(ks['paused'])} live agent variant(s)")
            else:
                print("guardrails: kill switch inactive")
        if args.check in ("breakers", "all"):
            breakers = detect_breakers(con)
            if breakers:
                print(f"guardrails: {len(breakers)} bleeding arm(s):")
                for b in breakers:
                    print(f"  bucket={b['bucket']} variant={b['variant_id']} meta={b['meta_object_id']} :: {b['reason']}")
            else:
                print("guardrails: no bleeding arms")
        if args.check in ("rollback", "all"):
            rolled = auto_rollback(con, args.pass_id, args.dry_run)
            if rolled:
                print(f"guardrails: rolled back {len(rolled)} variant(s):")
                for r in rolled:
                    print(f"  {r['slug']}: w{r['from']} -> w{r['to']} (rate {r['rate']} < 0.8*control {r['control_rate']})")
            else:
                print("guardrails: no rollbacks")
    finally:
        con.close()


if __name__ == "__main__":
    main()
