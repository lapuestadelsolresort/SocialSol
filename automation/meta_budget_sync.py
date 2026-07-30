#!/usr/bin/env python3
"""Push resort optimizer budget plans to Meta, gated by smoke tests.

Live writes require all of these:
  - optimizer_config.meta_mode == "auto"
  - optimizer_config.meta_dry_run_smoke_passed_at is set
  - optimizer_config.meta_live_smoke_passed_at is set

The default state is propose-only. Dry runs print the intended updates and make
no network calls.
"""

import argparse
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
ACTIVE_CAMPAIGNS = os.path.join(ROOT, "campaigns", "active-campaigns.json")
LOCAL_SECRETS = os.path.join(ROOT, "secrets", "meta.json")
SECRETS_DIR = os.environ.get("SOCIALSOL_SECRETS_DIR", os.path.join(ROOT, "secrets"))
SHARED_SECRETS = os.path.join(SECRETS_DIR, "meta.json")


def ensure_tables(con):
    con.execute(
        "CREATE TABLE IF NOT EXISTS optimizer_config ("
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS meta_smoke_tests ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')), "
        "kind TEXT NOT NULL, status TEXT NOT NULL, details TEXT)"
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


def set_cfg(con, key, value):
    con.execute(
        "INSERT INTO optimizer_config (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')",
        (key, json.dumps(value)),
    )


def mark_smoke(con, kind, status, details=None):
    if kind not in ("dry-run", "live"):
        raise ValueError("smoke kind must be dry-run or live")
    if status not in ("passed", "failed"):
        raise ValueError("smoke status must be passed or failed")
    now = datetime.now(timezone.utc).isoformat()
    con.execute(
        "INSERT INTO meta_smoke_tests (kind, status, details) VALUES (?, ?, ?)",
        (kind, status, json.dumps(details or {})),
    )
    if status == "passed":
        set_cfg(con, f"meta_{kind.replace('-', '_')}_smoke_passed_at", now)
    con.commit()
    return now


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def load_secrets():
    for path in (LOCAL_SECRETS, SHARED_SECRETS):
        data = load_json(path, None)
        if isinstance(data, dict) and data.get("access_token"):
            data["_path"] = path
            return data
    return {}


def api_version(secrets):
    return secrets.get("graph_api_version") or secrets.get("graph_version") or "v21.0"


def update_budget(secrets, object_id, daily_budget_usd):
    token = secrets["access_token"]
    url = f"https://graph.facebook.com/{api_version(secrets)}/{object_id}"
    data = urllib.parse.urlencode({
        "daily_budget": str(int(round(float(daily_budget_usd) * 100))),
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def budget_object(rec):
    if rec.get("budget_object_id"):
        return str(rec["budget_object_id"])
    if rec.get("budget_level") == "campaign":
        return str(rec.get("campaign_id") or "")
    return str(rec.get("adset_id") or "")


def budget_amount(rec):
    if rec.get("budget_level") == "campaign":
        return rec.get("campaign_daily_budget_usd")
    return rec.get("daily_budget_usd")


def budget_registry(records):
    objects = {}
    aliases = {}
    for rec in records:
        if rec.get("status") != "ACTIVE":
            continue
        obj = budget_object(rec)
        amount = budget_amount(rec)
        if not obj or amount is None:
            continue
        objects.setdefault(obj, float(amount))
        for alias in (rec.get("adset_id"), rec.get("campaign_id"), obj):
            if alias:
                aliases[str(alias)] = obj
    return objects, aliases


def current_total(records):
    objects, _ = budget_registry(records)
    return round(sum(objects.values()), 2)


def plan_targets(con, today_s):
    try:
        rows = con.execute(
            "SELECT meta_object_id, SUM(planned_spend) FROM budget_ledger "
            "WHERE date=? AND meta_object_id IS NOT NULL AND meta_object_id<>'' "
            "GROUP BY meta_object_id",
            (today_s,),
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    return {str(obj): round(float(amount or 0), 2) for obj, amount in rows if amount and amount > 0}


def cap_from_config(cfg):
    return float(cfg.get("budget_cap_daily", 0) or 0)


def smoke_gate(cfg):
    missing = []
    if not cfg.get("meta_dry_run_smoke_passed_at"):
        missing.append("meta_dry_run_smoke_passed_at")
    if not cfg.get("meta_live_smoke_passed_at"):
        missing.append("meta_live_smoke_passed_at")
    return missing


def _decision(con, pass_id, target, before, after, rationale):
    con.execute(
        "INSERT INTO decisions (pass_id, actor, action, target_kind, target_id, before, after, rationale) "
        "VALUES (?, 'meta_budget_sync', 'update_budget', 'meta_budget_object', ?, ?, ?, ?)",
        (pass_id, target, json.dumps(before), json.dumps(after), rationale),
    )


def sync(con, plan=None, dry_run=False, pass_id="manual", today=None):
    ensure_tables(con)
    cfg = load_cfg(con)
    mode = cfg.get("meta_mode", "propose")
    today_s = (today or date.today()).isoformat()
    cap = cap_from_config(cfg)
    result = {
        "mode": mode,
        "date": today_s,
        "cap": cap,
        "dry_run": dry_run,
        "source": None,
        "updates": [],
        "skipped": [],
    }
    if cap <= 0:
        result["skipped"].append("budget_cap_zero")
        return result

    targets = {}
    if plan and isinstance(plan, dict):
        for row in plan.get("plan", []):
            obj = row.get("meta_object_id")
            amount = row.get("planned_spend")
            if obj and amount and amount > 0:
                targets[str(obj)] = round(targets.get(str(obj), 0) + float(amount), 2)
        if targets:
            result["source"] = "allocator_plan"
    if not targets:
        targets = plan_targets(con, today_s)
        if targets:
            result["source"] = "budget_ledger"
    if not targets:
        result["skipped"].append("no_meta_targets")
        return result

    records = load_json(ACTIVE_CAMPAIGNS, [])
    if not isinstance(records, list):
        records = []
    object_budgets, aliases = budget_registry(records)
    normalized_targets = {}
    unknown_targets = []
    for source_obj, amount in targets.items():
        target_obj = aliases.get(str(source_obj))
        if not target_obj:
            unknown_targets.append(str(source_obj))
            continue
        normalized_targets[target_obj] = round(normalized_targets.get(target_obj, 0) + amount, 2)
    if unknown_targets:
        result["skipped"].append("unknown_meta_targets:" + ",".join(sorted(unknown_targets)))
        return result
    targets = normalized_targets
    if not targets:
        result["skipped"].append("no_registered_meta_targets")
        return result

    projected_total = round(
        sum(amount for obj, amount in object_budgets.items() if obj not in targets)
        + sum(targets.values()),
        2,
    )
    result["projected_active_campaign_total"] = projected_total
    if projected_total > cap + 0.01:
        result["skipped"].append(f"projected_total_exceeds_cap:{projected_total}>{cap}")
        return result

    result["active_campaign_total_before"] = current_total(records if isinstance(records, list) else [])

    if dry_run:
        for obj, amount in sorted(targets.items()):
            before = object_budgets.get(obj)
            result["updates"].append({"object_id": obj, "before": before, "after": amount, "status": "dry_run"})
        return result

    if mode != "auto":
        result["skipped"].append("meta_mode_not_auto")
        return result
    missing = smoke_gate(cfg)
    if missing:
        result["skipped"].append("missing_smoke_gate:" + ",".join(missing))
        return result

    secrets = load_secrets()
    if not secrets.get("access_token"):
        result["skipped"].append("meta_not_configured")
        return result

    changed_records = False
    for obj, amount in sorted(targets.items()):
        before = object_budgets.get(obj)
        if before is not None and abs(before - amount) < 0.005:
            result["skipped"].append(f"{obj}:already_at_target")
            continue
        update = {"object_id": obj, "before": before, "after": amount}
        try:
            payload = update_budget(secrets, obj, amount)
            update["status"] = "ok" if payload else "unknown"
            for rec in records:
                if budget_object(rec) == obj:
                    if rec.get("budget_level") == "campaign":
                        rec["campaign_daily_budget_usd"] = amount
                    else:
                        rec["daily_budget_usd"] = amount
                    changed_records = True
            _decision(con, pass_id, obj, before, amount, f"source={result['source']} cap=${cap}")
        except Exception as e:
            update["status"] = "failed"
            update["error"] = str(e)
        result["updates"].append(update)

    if changed_records:
        write_json(ACTIVE_CAMPAIGNS, records)
    if any(u.get("status") == "ok" for u in result["updates"]):
        con.commit()
    return result


def main():
    ap = argparse.ArgumentParser(description="Sync resort optimizer budget plan to Meta")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pass-id", dest="pass_id", default="manual")
    ap.add_argument("--mark-smoke", choices=["dry-run", "live"], help="Record a passed smoke gate after operator verification")
    ap.add_argument("--smoke-status", choices=["passed", "failed"], default="passed")
    args = ap.parse_args()

    con = sqlite3.connect(DB_PATH, timeout=20)
    con.execute("PRAGMA busy_timeout=20000")
    try:
        ensure_tables(con)
        if args.mark_smoke:
            at = mark_smoke(con, args.mark_smoke, args.smoke_status, {"recorded_by": "meta_budget_sync.py"})
            print(json.dumps({"marked": args.mark_smoke, "status": args.smoke_status, "at": at}, indent=2))
            return
        print(json.dumps(sync(con, dry_run=args.dry_run, pass_id=args.pass_id), indent=2))
    finally:
        con.close()


if __name__ == "__main__":
    main()
