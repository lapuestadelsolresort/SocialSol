#!/usr/bin/env python3
"""Shared plumbing for resort optimizer generators.

Generators are propose-mode only: they register draft variants with weight 0,
log an experiment as proposed, and post a Slack proposal. They never publish,
activate, or spend.
"""

import json
import os
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
ROOT = os.path.dirname(SCRIPTS)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
VARIANTS_DIR = os.environ.get("LP_VARIANTS_DIR", os.path.join(ROOT, "lp", "variants"))
APPROVAL_CHANNEL_ID = os.environ.get("RESORT_APPROVAL_CHANNEL", "")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")

sys.path.insert(0, SCRIPTS)
import compliance_check as cc  # noqa: E402

_PHRASES = None


def phrases():
    global _PHRASES
    if _PHRASES is None:
        _PHRASES = cc.load_hard_blocks(cc.RULES_MD)
    return _PHRASES


def connect():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.execute("PRAGMA busy_timeout=15000")
    ensure_tables(con)
    return con


def ensure_tables(con):
    con.execute(
        "CREATE TABLE IF NOT EXISTS lp_variants ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, page_slug TEXT NOT NULL, "
        "language TEXT NOT NULL DEFAULT 'en', source TEXT, audience TEXT, status TEXT NOT NULL DEFAULT 'draft', "
        "traffic_weight INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, experiment_id INTEGER, "
        "type TEXT DEFAULT 'landing_page', is_control INTEGER DEFAULT 0, compliance_status TEXT DEFAULT 'unknown', "
        "bucket TEXT DEFAULT 'leads', funnel_stage TEXT DEFAULT 'cta', meta_object_id TEXT, "
        "created_by TEXT DEFAULT 'seed', approved_by TEXT, approved_at TEXT, retired_at TEXT, "
        "created_at TEXT DEFAULT (datetime('now')))"
    )
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_lpv_slug ON lp_variants(slug)")
    for spec in [
        "experiment_id INTEGER",
        "type TEXT DEFAULT 'landing_page'",
        "is_control INTEGER DEFAULT 0",
        "compliance_status TEXT DEFAULT 'unknown'",
        "bucket TEXT DEFAULT 'leads'",
        "funnel_stage TEXT DEFAULT 'cta'",
        "meta_object_id TEXT",
    ]:
        try:
            con.execute(f"ALTER TABLE lp_variants ADD COLUMN {spec}")
        except sqlite3.OperationalError:
            pass
    con.execute(
        "CREATE TABLE IF NOT EXISTS experiments ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, "
        "status TEXT NOT NULL DEFAULT 'running', kind TEXT, bucket TEXT, funnel_stage TEXT, "
        "blast_radius TEXT DEFAULT 'low', hypothesis TEXT, rationale TEXT, change_made TEXT, "
        "primary_metric TEXT NOT NULL, guardrail_metrics TEXT, baseline_value TEXT, target_value TEXT, "
        "observation_window TEXT, review_at TEXT, linked_variant_slug TEXT, linked_campaign_id TEXT, "
        "linked_utm_campaign TEXT, result TEXT, conclusion TEXT, source TEXT DEFAULT 'operator', "
        "created_by TEXT DEFAULT 'sol', created_at TEXT DEFAULT (datetime('now')), "
        "updated_at TEXT DEFAULT (datetime('now')), concluded_at TEXT)"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS decisions ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')), "
        "pass_id TEXT, actor TEXT DEFAULT 'optimizer', action TEXT NOT NULL, target_kind TEXT, "
        "target_id TEXT, before TEXT, after TEXT, rationale TEXT)"
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS optimizer_compliance_failures ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')), "
        "draft_id TEXT, channel TEXT, failed_check TEXT, details TEXT, source TEXT DEFAULT 'agent_generated')"
    )


def gate(artifact, kind=None, source="agent_generated", draft_id=None):
    ok, failures = cc.check_artifact(artifact, phrases=phrases(), kind=kind)
    if not ok:
        cc.log_failures(failures, artifact, source, draft_id=draft_id, channel=kind, db_path=DB_PATH)
    return ok, failures


def generate_until_compliant(produce, kind=None, max_tries=5, label="draft"):
    last_failures = []
    for idx in range(1, max_tries + 1):
        draft = produce(idx)
        if draft is None:
            break
        ok, failures = gate(draft, kind=kind, draft_id=f"{label}-{idx}")
        if ok:
            return draft, idx, []
        last_failures = failures
    return None, max_tries, last_failures


def load_base_config(con, page_slug, slug=None):
    row = None
    if slug:
        row = con.execute("SELECT config FROM lp_variants WHERE slug=?", (slug,)).fetchone()
    if not row:
        row = con.execute(
            "SELECT config FROM lp_variants WHERE page_slug=? AND status='live' "
            "ORDER BY traffic_weight DESC LIMIT 1",
            (page_slug,),
        ).fetchone()
    if row:
        try:
            return json.loads(row[0])
        except (json.JSONDecodeError, TypeError):
            pass
    path = os.path.join(VARIANTS_DIR, f"{page_slug}-control-en.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except OSError:
        return {
            "page_slug": page_slug,
            "language": "en",
            "hero": {"headline": "La Puesta del Sol", "sub": "Private beachfront resort in Riviera Nayarit, Mexico."},
            "cta": {"text": "Message Us on WhatsApp", "whatsapp_prefill": "Hi Sarah, could we set up a quick call?"},
            "social_proof": {"enabled": False, "lines": []},
            "urgency": None,
        }


def write_mirror(slug, config):
    os.makedirs(VARIANTS_DIR, exist_ok=True)
    with open(os.path.join(VARIANTS_DIR, f"{slug}.json"), "w", encoding="utf-8") as fh:
        json.dump(config, fh, indent=2)
        fh.write("\n")


def create_experiment(con, slug, title, primary_metric, bucket, funnel_stage,
                      hypothesis=None, linked_variant_slug=None, review_at=None):
    con.execute(
        "INSERT INTO experiments (slug, title, status, kind, bucket, funnel_stage, hypothesis, "
        "primary_metric, linked_variant_slug, review_at, source, created_by) "
        "VALUES (?, ?, 'proposed', 'lp_variant', ?, ?, ?, ?, ?, ?, 'agent', 'sol') "
        "ON CONFLICT(slug) DO NOTHING",
        (slug, title, bucket, funnel_stage, hypothesis, primary_metric, linked_variant_slug, review_at),
    )
    row = con.execute("SELECT id FROM experiments WHERE slug=?", (slug,)).fetchone()
    return row[0] if row else None


def register_variant(con, slug, config, page_slug, language="en", source=None, audience=None,
                     experiment_id=None, weight=0, status="draft", bucket="leads"):
    config = dict(config)
    config.update({
        "slug": slug,
        "page_slug": page_slug,
        "language": language,
        "status": status,
        "traffic_weight": weight,
        "type": "landing_page",
        "bucket": bucket,
        "funnel_stage": "cta",
        "compliance_status": "passed",
    })
    if source is not None:
        config["source"] = source
    if audience is not None:
        config["audience"] = audience
    con.execute(
        "INSERT INTO lp_variants (slug, page_slug, language, source, audience, status, traffic_weight, "
        "config, experiment_id, type, is_control, compliance_status, bucket, funnel_stage, created_by) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'landing_page', 0, 'passed', ?, 'cta', 'agent')",
        (slug, page_slug, language, source, audience, status, weight, json.dumps(config), experiment_id, bucket),
    )
    variant_id = con.execute("SELECT id FROM lp_variants WHERE slug=?", (slug,)).fetchone()[0]
    write_mirror(slug, config)
    return variant_id


def decision(con, pass_id, action, target_kind, target_id, before, after, rationale, actor="generator"):
    con.execute(
        "INSERT INTO decisions (pass_id, actor, action, target_kind, target_id, before, after, rationale) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            pass_id,
            actor,
            action,
            target_kind,
            target_id,
            json.dumps(before) if before is not None else None,
            json.dumps(after) if after is not None else None,
            rationale,
        ),
    )


def propose(summary):
    if os.environ.get("GEN_NO_SLACK"):
        print(f"[gen] (GEN_NO_SLACK) would propose to #social-sol:\n{summary}")
        return True
    if not APPROVAL_CHANNEL_ID or not SLACK_ACCOUNT:
        print("[gen] Slack integration is not configured", file=sys.stderr)
        return False
    try:
        subprocess.run(
            [OPENCLAW, "message", "send", "--channel", "slack",
             "--account", SLACK_ACCOUNT, "--target", f"channel:{APPROVAL_CHANNEL_ID}",
             "--message", str(summary)],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return True
    except Exception as e:
        print(f"[gen] propose post failed (non-fatal): {e}", file=sys.stderr)
        return False
