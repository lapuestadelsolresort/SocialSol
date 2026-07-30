#!/usr/bin/env python3
"""Apply a reversible resort landing-page variant change.

This is the only write path the optimizer uses for live serving changes. It can
change status and traffic_weight only, and mirrors the same value into
lp/variants/<slug>.json so the file mirror stays in sync with the DB.
"""

import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "crm", "data", "crm.db"))
VARIANTS_DIR = os.path.join(ROOT, "lp", "variants")

ALLOWED_STATUS = {"live", "paused", "draft", "retired"}
WRITABLE = {"traffic_weight", "status"}


def connect():
    if not os.path.exists(DB_PATH):
        sys.stderr.write(f"apply_variant: no DB at {DB_PATH}\n")
        sys.exit(2)
    return sqlite3.connect(DB_PATH, timeout=10)


def get_variant(cur, slug):
    cur.execute(
        "SELECT slug, page_slug, language, source, audience, status, traffic_weight "
        "FROM lp_variants WHERE slug=?",
        (slug,),
    )
    row = cur.fetchone()
    if not row:
        return None
    keys = ["slug", "page_slug", "language", "source", "audience", "status", "traffic_weight"]
    return dict(zip(keys, row))


def mirror_json(slug, field, value):
    path = os.path.join(VARIANTS_DIR, f"{slug}.json")
    if not os.path.exists(path):
        return f"no JSON mirror at lp/variants/{slug}.json"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError) as e:
        return f"could not update JSON mirror: {e}"
    data[field] = value
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    return f"mirrored to lp/variants/{slug}.json"


def show(args):
    con = connect()
    cur = con.cursor()
    if args.slug:
        v = get_variant(cur, args.slug)
        con.close()
        if not v:
            sys.stderr.write(f"not found: {args.slug}\n")
            sys.exit(1)
        print(json.dumps(v, indent=2))
        return
    cur.execute(
        "SELECT slug, page_slug, language, status, traffic_weight, source, audience "
        "FROM lp_variants ORDER BY page_slug, language, status DESC, slug"
    )
    rows = cur.fetchall()
    con.close()
    print(f"{len(rows)} variant(s):")
    for slug, page, lang, status, weight, source, audience in rows:
        print(f"  [{status:<7}] w{str(weight):>3}  {page}/{lang}  {slug}  src={source or '*'} aud={audience or '*'}")


def apply_change(args, field, value):
    assert field in WRITABLE
    con = connect()
    cur = con.cursor()
    v = get_variant(cur, args.slug)
    if not v:
        con.close()
        sys.stderr.write(f"not found: {args.slug}\n")
        sys.exit(1)
    before = v[field]
    if before == value:
        con.close()
        print(f"no change: {args.slug} {field} already {value!r}")
        return
    try:
        cur.execute(f"UPDATE lp_variants SET {field}=? WHERE slug=?", (value, args.slug))
        con.commit()
    except sqlite3.Error as e:
        con.close()
        sys.stderr.write(f"DB error: {e}\n")
        sys.exit(2)
    con.close()

    mirror = mirror_json(args.slug, field, value)
    print(f"applied: {args.slug} {field} {before!r} -> {value!r}")
    if args.reason:
        print(f"  reason: {args.reason}")
    print(f"  live now; {mirror}")
    print("  remember: keep the linked experiment and metrics ledger current.")


def cmd_weight(args):
    if args.value < 0 or args.value > 100:
        sys.stderr.write("weight must be an integer 0-100\n")
        sys.exit(1)
    apply_change(args, "traffic_weight", args.value)


def cmd_status(args):
    if args.value not in ALLOWED_STATUS:
        sys.stderr.write("status must be one of: draft, live, paused, retired\n")
        sys.exit(1)
    apply_change(args, "status", args.value)


def main():
    ap = argparse.ArgumentParser(description="Apply a reversible LP variant status or weight change.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_show = sub.add_parser("show")
    p_show.add_argument("slug", nargs="?")
    p_show.set_defaults(func=show)

    p_weight = sub.add_parser("weight")
    p_weight.add_argument("slug")
    p_weight.add_argument("value", type=int)
    p_weight.add_argument("--reason")
    p_weight.set_defaults(func=cmd_weight)

    p_status = sub.add_parser("status")
    p_status.add_argument("slug")
    p_status.add_argument("value")
    p_status.add_argument("--reason")
    p_status.set_defaults(func=cmd_status)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
