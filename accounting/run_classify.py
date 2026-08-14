#!/usr/bin/env python3
"""
Kapital Transaction Classifier — Main Entry Point

Usage:
    python run_classify.py <kapital_csv_file> [--dry-run] [--json] [--no-fx]

Parses a Kapital bank statement CSV, classifies each transaction,
converts MXN to USD, and outputs a report.

Flags:
    --dry-run   Don't push to QBO (default behavior for now)
    --json      Output raw JSON instead of formatted report
    --no-fx     Skip FX conversion (report in MXN only)
"""

import sys
import json
import os
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from kapital_parser import parse_kapital_csv
from classifier import KapitalClassifier, format_classification_report
from fx_rates import apply_transaction_fx


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    csv_path = sys.argv[1]
    dry_run = '--dry-run' in sys.argv or True  # Always dry-run for now
    output_json = '--json' in sys.argv
    skip_fx = '--no-fx' in sys.argv

    # Parse
    print(f"📂 Parsing {csv_path}...")
    meta, transactions = parse_kapital_csv(csv_path)

    print(f"   Entity: {meta.get('entity', 'N/A')}")
    print(f"   RFC: {meta.get('rfc', 'N/A')}")
    print(f"   Opening balance: ${meta.get('opening_balance', 0):,.2f} MXN")
    print(f"   Raw transactions: {meta.get('transaction_count', 0)}")
    print(f"   Grouped (SPEI triplets merged): {meta.get('grouped_count', 0)}")
    print()

    # Classify
    print("🏷️  Classifying...")
    classifier = KapitalClassifier()
    results = classifier.classify_all(transactions)

    # Add FX conversion
    if not skip_fx:
        print("💱 Converting MXN → USD...")
        fx_errors = []
        for bucket in ['auto', 'guess', 'unknown']:
            for txn in results[bucket]:
                if txn.get('date'):
                    try:
                        apply_transaction_fx(txn)
                    except Exception as e:
                        fx_errors.append(f"  ⚠️ {txn['date']}: {e}")
                        txn['fx_rate'] = None
                        txn['amount_usd'] = None

        if fx_errors:
            print(f"   FX errors ({len(fx_errors)}):")
            for err in fx_errors:
                print(err)
        print()

    # Output
    machine_output = None
    if output_json:
        # JSON output (for programmatic use)
        output = {
            'metadata': {k: str(v) if not isinstance(v, (int, float, str, bool, type(None))) else v
                         for k, v in meta.items()},
            'results': {
                bucket: [
                    {k: str(v) if hasattr(v, 'isoformat') else v
                     for k, v in txn.items()
                     if k not in ('spei_fees',)}  # Skip nested fee objects in JSON
                    for txn in txns
                ]
                for bucket, txns in results.items()
            },
            'summary': {
                'auto': len(results['auto']),
                'guess': len(results['guess']),
                'unknown': len(results['unknown']),
                'total': sum(len(v) for v in results.values()),
            }
        }
        machine_output = output
        print(json.dumps(output, indent=2, default=str))
    else:
        # Determine month label from transactions
        dates = [t['date'] for bucket in results.values() for t in bucket if t.get('date')]
        if dates:
            month_label = dates[0].strftime('%B %Y')
        else:
            month_label = ''

        report = format_classification_report(results, month_label)
        print(report)

        # Print USD summary if FX was applied
        if not skip_fx:
            print("\n\n💵 *USD Summary:*")
            usd_totals = {}
            for bucket in ['auto', 'guess']:
                for t in results[bucket]:
                    cat = t.get('category_name', 'Unclassified')
                    usd = t.get('amount_usd', 0) or 0
                    direction = t.get('direction', 'debit')
                    if direction == 'debit':
                        if cat not in usd_totals:
                            usd_totals[cat] = 0.0
                        usd_totals[cat] += usd

            for cat, total in sorted(usd_totals.items(), key=lambda x: -x[1]):
                print(f"  • {cat}: ${total:,.2f} USD")

    # Summary
    print(f"\n{'='*50}")
    print(f"Auto: {len(results['auto'])} | Guess: {len(results['guess'])} | Unknown: {len(results['unknown'])}")
    if dry_run:
        print("🔒 DRY RUN — nothing pushed to QBO")
    if machine_output is not None:
        # Final compact line is the durable runner's unambiguous parse target.
        print(json.dumps(machine_output, separators=(',', ':'), default=str))


if __name__ == '__main__':
    main()
