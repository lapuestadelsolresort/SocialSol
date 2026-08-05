#!/usr/bin/env python3
"""Resort optimizer orchestration loop.

Light pass: guardrails, selector, budget plan, Meta sync in dry/propose-safe
mode. Heavy pass: generate one draft proposal for the current weak funnel stage.
"""

import argparse
import os
import sqlite3
import subprocess
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
CHANNEL = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")

sys.path.insert(0, HERE)
import budget_allocator  # noqa: E402
import guardrails  # noqa: E402
import meta_budget_sync  # noqa: E402
import selector  # noqa: E402

QUALIFIED = guardrails.QUALIFIED
NOT_BOT = "is_bot=0"


def connect():
    con = sqlite3.connect(DB_PATH, timeout=20)
    con.execute("PRAGMA busy_timeout=20000")
    return con


def slack(message):
    if not CHANNEL or not SLACK_ACCOUNT:
        print("[orchestrator] Slack integration is not configured", file=sys.stderr)
        return False
    try:
        subprocess.run(
            [OPENCLAW, "message", "send", "--channel", "slack", "--account", SLACK_ACCOUNT,
             "--target", f"channel:{CHANNEL}", "--message", str(message)],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return True
    except Exception as e:
        print(f"[orchestrator] slack post failed (non-fatal): {e}", file=sys.stderr)
        return False


def diagnose(con):
    def c(sql, params=()):
        try:
            return con.execute(sql, params).fetchone()[0] or 0
        except sqlite3.OperationalError:
            return 0

    sessions = c(f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT}")
    qualified = c(f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND {QUALIFIED}")
    cta = c(f"SELECT COALESCE(SUM(reached_cta),0) FROM page_sessions WHERE {NOT_BOT}")
    clicks = c(f"SELECT COALESCE(SUM(cta_clicked),0) FROM page_sessions WHERE {NOT_BOT}")
    stages = [
        ("sessions_to_qualified", "engagement", (qualified / sessions) if sessions else 0, sessions),
        ("qualified_to_cta", "engagement", (cta / qualified) if qualified else 0, qualified),
        ("cta_to_whatsapp", "leads", (clicks / cta) if cta else 0, cta),
    ]
    live = [stage for stage in stages if stage[3] > 0]
    if not live:
        return None
    worst = min(live, key=lambda row: row[2])
    return {"stage": worst[0], "bucket": worst[1], "rate": round(worst[2], 3), "exposure": worst[3]}


def light_pass(dry_run=False):
    pass_id = uuid.uuid4().hex[:12]
    con = connect()
    log = [f"light pass {pass_id}"]
    try:
        ks = guardrails.kill_switch(con, pass_id, dry_run)
        if ks["active"]:
            log.append(f"kill switch active: {ks['reason']} paused={len(ks['paused'])}")
            print("\n".join(log))
            return
        moves = selector.run(con, pass_id, dry_run=dry_run, reason="hourly bandit")
        log.append(f"selector: {len(moves)} weight change(s)")
        rolled = guardrails.auto_rollback(con, pass_id, dry_run=dry_run)
        log.append(f"rollbacks: {len(rolled)}")
        breakers = guardrails.detect_breakers(con)
        if breakers and not dry_run:
            slack("*Resort optimizer alert*\n" + "\n".join(f"- {b['meta_object_id'] or b['variant_id']}: {b['reason']}" for b in breakers))
        log.append(f"breakers: {len(breakers)}")
        plan = budget_allocator.allocate(con, dry_run=dry_run, pass_id=pass_id)
        log.append("allocator: killed" if plan["killed"] else f"allocator: planned {len(plan['plan'])} line(s)")
        sync = meta_budget_sync.sync(con, plan=plan, dry_run=True if dry_run else False, pass_id=pass_id)
        log.append(f"meta sync: updates={len(sync['updates'])} skipped={len(sync['skipped'])}")
    finally:
        con.close()
    print("\n".join(log))


def heavy_pass(dry_run=False):
    pass_id = uuid.uuid4().hex[:12]
    con = connect()
    try:
        binding = diagnose(con)
    finally:
        con.close()
    if not binding:
        print(f"heavy pass {pass_id}: no sessions yet")
        return
    cmd = [
        sys.executable,
        os.path.join(HERE, "generate", "gen_landing.py"),
        "--page-slug",
        "retreats",
        "--pass-id",
        pass_id,
    ]
    if dry_run:
        print(f"heavy pass {pass_id}: would run {' '.join(cmd)} for {binding}")
        return
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    print(f"heavy pass {pass_id}: binding={binding}")
    print(out.stdout.strip())
    if out.returncode:
        print(out.stderr.strip(), file=sys.stderr)
        sys.exit(out.returncode)


def main():
    ap = argparse.ArgumentParser(description="Run resort optimizer pass")
    ap.add_argument("pass_kind", choices=["light", "heavy"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not os.path.exists(DB_PATH):
        sys.stderr.write(f"orchestrator: no DB at {DB_PATH}\n")
        sys.exit(2)
    (light_pass if args.pass_kind == "light" else heavy_pass)(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
