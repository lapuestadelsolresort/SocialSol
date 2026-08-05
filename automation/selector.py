#!/usr/bin/env python3
"""Thompson selector for resort landing-page variant weights.

The resort funnel is page view -> qualified session -> CTA view -> WhatsApp
click -> booked lead. The selector re-computes Beta posteriors from
page_sessions and adjusts traffic_weight within each serving group:
(page_slug, language, source, audience).
"""

import argparse
import json
import os
import random
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
APPLY_VARIANT = os.path.join(HERE, "apply_variant.py")

QUALIFIED = "(max_scroll_pct > 0 OR reached_cta = 1 OR dwell_ms >= 10000)"
NOT_BOT = "is_bot=0"

METRICS = {
    "wa_click_per_qualified": {
        "success": "cta_clicked = 1",
        "trial": QUALIFIED,
        "bucket": "leads",
    },
    "cta_view_per_session": {
        "success": "reached_cta = 1",
        "trial": "1=1",
        "bucket": "engagement",
    },
    "qualified_per_session": {
        "success": QUALIFIED,
        "trial": "1=1",
        "bucket": "engagement",
    },
}
DEFAULT_METRIC = "wa_click_per_qualified"

DEFAULTS = {
    "exploration_floor_share": 0.15,
    "promotion_gate_qualified": 100,
    "change_limits": {"max_weight_delta_per_pass": 0.25},
}


def ensure_tables(con):
    con.execute(
        "CREATE TABLE IF NOT EXISTS bandit_arms ("
        "arm_id INTEGER PRIMARY KEY, slug TEXT NOT NULL, bucket TEXT NOT NULL, metric TEXT NOT NULL, "
        "alpha REAL NOT NULL DEFAULT 1.0, beta REAL NOT NULL DEFAULT 1.0, "
        "n_qualified INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS decisions ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')), "
        "pass_id TEXT, actor TEXT DEFAULT 'optimizer', action TEXT NOT NULL, target_kind TEXT, "
        "target_id TEXT, before TEXT, after TEXT, rationale TEXT)"
    )


def load_cfg(con):
    cfg = dict(DEFAULTS)
    try:
        for key, value in con.execute("SELECT key, value FROM optimizer_config").fetchall():
            try:
                cfg[key] = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                cfg[key] = value
    except sqlite3.OperationalError:
        pass
    return cfg


def sample_beta(alpha, beta):
    return random.betavariate(max(alpha, 1e-6), max(beta, 1e-6))


def arm_metric(con, variant_id):
    try:
        row = con.execute("SELECT metric FROM bandit_arms WHERE arm_id=?", (variant_id,)).fetchone()
    except sqlite3.OperationalError:
        return DEFAULT_METRIC
    if row and row[0] in METRICS:
        return row[0]
    return DEFAULT_METRIC


def arm_stats(con, variant_id, metric):
    m = METRICS[metric]
    trials = con.execute(
        f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND variant_id=? AND {m['trial']}",
        (variant_id,),
    ).fetchone()[0] or 0
    successes = con.execute(
        f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND variant_id=? AND ({m['trial']}) AND ({m['success']})",
        (variant_id,),
    ).fetchone()[0] or 0
    n_qualified = con.execute(
        f"SELECT COUNT(*) FROM page_sessions WHERE {NOT_BOT} AND variant_id=? AND {QUALIFIED}",
        (variant_id,),
    ).fetchone()[0] or 0
    successes = min(successes, trials)
    return 1.0 + successes, 1.0 + (trials - successes), n_qualified, successes, trials


def upsert_arm(con, variant_id, slug, metric, alpha, beta, n_qualified):
    bucket = METRICS[metric]["bucket"]
    con.execute(
        "INSERT INTO bandit_arms (arm_id, slug, bucket, metric, alpha, beta, n_qualified, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) "
        "ON CONFLICT(arm_id) DO UPDATE SET slug=excluded.slug, bucket=excluded.bucket, "
        "metric=excluded.metric, alpha=excluded.alpha, beta=excluded.beta, "
        "n_qualified=excluded.n_qualified, updated_at=datetime('now')",
        (variant_id, slug, bucket, metric, alpha, beta, n_qualified),
    )


def allocate(arms, exploration_floor):
    if not arms:
        return {}
    draws = {a["variant_id"]: sample_beta(a["alpha"], a["beta"]) for a in arms}
    total = sum(draws.values()) or 1.0
    shares = {vid: val / total for vid, val in draws.items()}
    floor = exploration_floor / len(arms)
    shares = {vid: max(share, floor) for vid, share in shares.items()}
    norm = sum(shares.values()) or 1.0
    return {vid: share / norm for vid, share in shares.items()}


def shares_to_weights(shares):
    return {vid: max(1, round(share * 100)) for vid, share in shares.items()}


def clamp_delta(current, target, max_delta_points):
    if max_delta_points is None:
        return target
    return max(current - max_delta_points, min(current + max_delta_points, target))


def apply_weight(slug, weight, reason, dry_run):
    if dry_run:
        return True, f"[dry-run] would set {slug} weight -> {weight}"
    try:
        out = subprocess.run(
            [sys.executable, APPLY_VARIANT, "weight", slug, str(int(weight)), "--reason", reason],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return True, out.stdout.strip().splitlines()[0] if out.stdout else "applied"
    except subprocess.CalledProcessError as e:
        return False, f"apply_variant failed: {e.stderr.strip()}"
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return False, f"apply_variant error: {e}"


def log_decision(con, pass_id, action, slug, before, after, rationale):
    con.execute(
        "INSERT INTO decisions (pass_id, actor, action, target_kind, target_id, before, after, rationale) "
        "VALUES (?, 'selector', ?, 'lp_variant', ?, ?, ?, ?)",
        (pass_id, action, slug, json.dumps(before), json.dumps(after), rationale),
    )


def run(con, pass_id="manual", dry_run=False, reason="bandit reallocation"):
    if not dry_run:
        ensure_tables(con)
    cfg = load_cfg(con)
    floor = float(cfg.get("exploration_floor_share", 0.15))
    max_delta = cfg.get("change_limits", {}).get("max_weight_delta_per_pass", 0.25)
    max_delta_points = int(round(float(max_delta) * 100)) if max_delta is not None else None

    rows = con.execute(
        "SELECT id, slug, page_slug, language, source, audience, traffic_weight "
        "FROM lp_variants WHERE status='live'"
    ).fetchall()
    groups = {}
    for variant_id, slug, page, lang, source, audience, weight in rows:
        groups.setdefault((page, lang, source, audience), []).append({
            "variant_id": variant_id,
            "slug": slug,
            "weight": weight or 0,
        })

    planned = []
    for key, arms in groups.items():
        for arm in arms:
            metric = arm_metric(con, arm["variant_id"])
            alpha, beta, n_qualified, successes, trials = arm_stats(con, arm["variant_id"], metric)
            arm.update(metric=metric, alpha=alpha, beta=beta, n_qualified=n_qualified,
                       successes=successes, trials=trials)
            if not dry_run:
                upsert_arm(con, arm["variant_id"], arm["slug"], metric, alpha, beta, n_qualified)

        if len(arms) < 2:
            continue

        shares = allocate(arms, floor)
        targets = shares_to_weights(shares)
        for arm in arms:
            new_weight = clamp_delta(arm["weight"], targets[arm["variant_id"]], max_delta_points)
            if new_weight == arm["weight"]:
                continue
            rationale = (
                f"group={key} metric={arm['metric']} succ/trials={arm['successes']}/{arm['trials']} "
                f"nqual={arm['n_qualified']} share={shares[arm['variant_id']]:.3f}"
            )
            planned.append((arm["slug"], arm["weight"], new_weight, rationale))

    if not dry_run:
        con.commit()

    summary, applied = [], []
    for slug, before_weight, new_weight, rationale in planned:
        ok, msg = apply_weight(slug, new_weight, reason, dry_run)
        if ok and not dry_run:
            applied.append((slug, before_weight, new_weight, rationale))
        summary.append(f"  {slug}: w{before_weight} -> w{new_weight} ({rationale}) :: {msg}")

    if applied:
        for slug, before_weight, new_weight, rationale in applied:
            log_decision(con, pass_id, "reweight", slug, before_weight, new_weight, rationale)
        con.commit()
    return summary


def main():
    ap = argparse.ArgumentParser(description="Thompson selector for resort LP variant weights")
    ap.add_argument("--pass-id", dest="pass_id", default="manual")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reason", default="bandit reallocation")
    args = ap.parse_args()

    if not os.path.exists(DB_PATH):
        sys.stderr.write(f"selector: no DB at {DB_PATH}\n")
        sys.exit(2)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.execute("PRAGMA busy_timeout=15000")
    try:
        summary = run(con, pass_id=args.pass_id, dry_run=args.dry_run, reason=args.reason)
    finally:
        con.close()

    if not summary:
        print("selector: no weight changes (single-arm groups or all within delta clamp)")
    else:
        print(f"selector: {len(summary)} weight change(s){' [dry-run]' if args.dry_run else ''}:")
        print("\n".join(summary))


if __name__ == "__main__":
    main()
