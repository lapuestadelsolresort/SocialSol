#!/usr/bin/env python3
"""Generate a resort landing-page variant proposal.

This produces a draft config only. It never sets status=live, never raises
traffic_weight above 0, and never changes Meta spend.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _gen_common as g

PAGES = {"weddings", "fitness", "retreats", "summer-sale", "planners"}

SUBS = {
    "weddings": [
        "Private beachfront setting in Riviera Nayarit for an intimate destination wedding conversation.",
        "A full-property wedding stay 45 minutes from Puerto Vallarta airport, with room to plan calmly.",
    ],
    "fitness": [
        "Beachfront space for a focused wellness retreat, 45 minutes from Puerto Vallarta airport.",
        "A private resort setting for movement, recovery, meals, and quiet between sessions.",
    ],
    "retreats": [
        "Full-property buyout for teams of 15-35, 45 minutes from Puerto Vallarta airport.",
        "A private beachfront base for offsites that need focus, meals, and real downtime.",
    ],
    "planners": [
        "A private Riviera Nayarit resort backed by planner support and a clear referral commission.",
        "A relationship-led venue partnership for destination wedding and event planners.",
    ],
}

PREFILLS = {
    "weddings": "Hi Sarah, I am interested in hosting a wedding at La Puesta del Sol. Could we set up a quick call?",
    "fitness": "Hi Sarah, I am a fitness and wellness event coordinator interested in a retreat at La Puesta del Sol. Can we chat?",
    "retreats": "Hi Sarah, I am interested in hosting a corporate retreat at La Puesta del Sol. Could we set up a quick call?",
    "planners": "Hi Sarah, I am a wedding or event planner interested in La Puesta del Sol's venue partner program. Could we connect?",
}


def smoke_test_config(config):
    if not isinstance(config.get("hero"), dict):
        return False, "missing hero"
    if not str(config["hero"].get("headline", "")).strip():
        return False, "missing hero.headline"
    if not isinstance(config.get("cta"), dict):
        return False, "missing cta"
    if not str(config["cta"].get("text", "")).strip():
        return False, "missing cta.text"
    if not str(config["cta"].get("whatsapp_prefill", "")).strip():
        return False, "missing cta.whatsapp_prefill"
    return True, "ok"


def main():
    ap = argparse.ArgumentParser(description="Generate a draft resort LP variant config")
    ap.add_argument("--spec", help="JSON spec file, or - for stdin")
    ap.add_argument("--page-slug", choices=sorted(PAGES), default=None)
    ap.add_argument("--language", default=None)
    ap.add_argument("--source")
    ap.add_argument("--audience")
    ap.add_argument("--pass-id", dest="pass_id", default="manual")
    ap.add_argument("--max-tries", dest="max_tries", type=int, default=5)
    args = ap.parse_args()

    spec = {}
    if args.spec:
        raw = sys.stdin.read() if args.spec == "-" else open(args.spec, encoding="utf-8").read()
        spec = json.loads(raw) if raw.strip() else {}
    page_slug = args.page_slug or spec.get("page_slug") or "retreats"
    if page_slug not in PAGES:
        print(f"gen_landing: bad page_slug {page_slug}", file=sys.stderr)
        sys.exit(2)
    language = args.language or spec.get("language") or "en"
    source = args.source or spec.get("source")
    audience = args.audience or spec.get("audience")
    bucket = spec.get("bucket", "leads")

    con = g.connect()
    try:
        base = g.load_base_config(con, page_slug)
        subs = SUBS[page_slug]

        def produce(attempt):
            cfg = json.loads(json.dumps(base))
            cfg.setdefault("hero", {})
            cfg["hero"]["headline"] = spec.get("hero_headline") or cfg["hero"].get("headline") or "La Puesta del Sol"
            cfg["hero"]["sub"] = spec.get("hero_sub") if (spec.get("hero_sub") and attempt == 1) else subs[(attempt - 1) % len(subs)]
            cfg.setdefault("cta", {})
            cfg["cta"]["text"] = spec.get("cta_text") or cfg["cta"].get("text") or "Message Us on WhatsApp"
            cfg["cta"]["whatsapp_prefill"] = spec.get("whatsapp_prefill") or PREFILLS[page_slug]
            if isinstance(spec.get("social_proof"), dict):
                cfg["social_proof"] = spec["social_proof"]
            if spec.get("urgency"):
                cfg["urgency"] = spec["urgency"]
                if spec.get("urgency_basis"):
                    cfg["urgency_basis"] = spec["urgency_basis"]
            return {"type": "landing_page", **cfg}

        draft, tries, failures = g.generate_until_compliant(
            produce,
            kind="landing_page",
            max_tries=args.max_tries,
            label="landing",
        )
        if draft is None:
            print(f"gen_landing: abandoned after {tries} tries - all drafts blocked", file=sys.stderr)
            for f in failures:
                print(f"  last fail: {f['rule']} - {f['trigger']}", file=sys.stderr)
            sys.exit(1)

        config = {k: v for k, v in draft.items() if k != "type"}
        ok, reason = smoke_test_config(config)
        if not ok:
            print(f"gen_landing: smoke test failed ({reason}) - not registering", file=sys.stderr)
            sys.exit(1)

        n = con.execute("SELECT COUNT(*) FROM lp_variants WHERE slug LIKE ?", (f"gen-{page_slug}-{language}-%",)).fetchone()[0]
        slug = f"gen-{page_slug}-{language}-{n + 1}"
        exp_id = g.create_experiment(
            con,
            f"exp-{slug}",
            f"LP draft: {page_slug} WhatsApp CTA",
            primary_metric="wa_click_per_qualified",
            bucket=bucket,
            funnel_stage="cta",
            hypothesis=spec.get("hypothesis"),
            linked_variant_slug=slug,
        )
        variant_id = g.register_variant(
            con,
            slug,
            config,
            page_slug,
            language=language,
            source=source,
            audience=audience,
            experiment_id=exp_id,
            weight=0,
            status="draft",
            bucket=bucket,
        )
        g.decision(
            con,
            args.pass_id,
            "generate",
            "lp_variant",
            slug,
            None,
            {"hero": config["hero"]["headline"], "cta": config["cta"]["text"]},
            f"gen_landing tries={tries} smoke=ok bucket={bucket}",
        )
        con.commit()

        summary = (
            f"*New resort LP draft* `{slug}` (id {variant_id}) - smoke OK, review before ramp\n"
            f"- Page: {page_slug}\n"
            f"- Hero: {config['hero']['headline']}\n"
            f"- Sub: {config['hero'].get('sub', '')}\n"
            f"- CTA: {config['cta'].get('text', '')}\n"
            f"- Bucket: {bucket}; compliance passed on try {tries}\n"
            f"- To ramp after approval: `scripts/apply_variant.py status {slug} live`, then `weight {slug} <n>`"
        )
        g.propose(summary)
        print(f"gen_landing: registered draft {slug} (id {variant_id}); smoke OK; proposed to #social-sol")
    finally:
        con.close()


if __name__ == "__main__":
    main()
