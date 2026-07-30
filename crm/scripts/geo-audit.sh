#!/bin/bash
# Meta Ads Geo Audit — Weekly check that ad spend stays in approved markets
# Approved markets: US, CA only. Flags MX or any other country.
# Runs via LaunchAgent every Monday 9am PDT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
SECRETS_DIR="${SOCIALSOL_SECRETS_DIR:-${REPO_ROOT}/secrets}"
TOKEN=$(jq -r .access_token "$SECRETS_DIR/meta.json")
ACT=$(jq -r .ad_account_act "$SECRETS_DIR/meta.json")
G="https://graph.facebook.com/v21.0"

APPROVED_COUNTRIES='["US", "CA"]'

# 1. Check all active adset targeting
ADSETS=$(curl -fsS --get -H "Authorization: Bearer ${TOKEN}" \
  --data-urlencode "fields=id,name,status,targeting" \
  --data-urlencode "limit=50" \
  "${G}/${ACT}/adsets")

# 2. Pull last 7 day spend by country
SPEND_BY_COUNTRY=$(curl -fsS --get -H "Authorization: Bearer ${TOKEN}" \
  --data-urlencode "fields=spend,impressions" \
  --data-urlencode "breakdowns=country" \
  --data-urlencode "date_preset=last_7d" \
  "${G}/${ACT}/insights")

# 3. Analyze with Python
ADSETS_JSON="$ADSETS" SPEND_JSON="$SPEND_BY_COUNTRY" python3 << 'PYEOF'
import json, sys, os

approved = {"US", "CA"}

# --- Check ad set targeting ---
adsets = json.loads(os.environ.get("ADSETS_JSON", "{}"))
spend_data = json.loads(os.environ.get("SPEND_JSON", "{}"))

alerts = []
clean = True

for a in adsets.get("data", []):
    if a.get("status") != "ACTIVE":
        continue
    countries = a.get("targeting", {}).get("geo_locations", {}).get("countries", [])
    bad = [c for c in countries if c not in approved]
    if bad:
        clean = False
        alerts.append(f"🚨 *{a['name']}* targets non-approved countries: {', '.join(bad)}")

# --- Check actual spend leakage ---
total_spend = 0
country_spend = {}
for row in spend_data.get("data", []):
    s = float(row.get("spend", 0))
    c = row.get("country", "??")
    total_spend += s
    country_spend[c] = country_spend.get(c, 0) + s

if total_spend > 0:
    for c, s in sorted(country_spend.items(), key=lambda x: -x[1]):
        pct = (s / total_spend) * 100
        if c not in approved and pct > 2:
            clean = False
            alerts.append(f"🚨 *{c}* received {pct:.1f}% of spend (${s:.2f}/${total_spend:.2f}) last 7 days")

# --- Build summary ---
if total_spend > 0:
    summary_parts = []
    for c in sorted(country_spend, key=lambda x: -country_spend[x]):
        pct = (country_spend[c] / total_spend) * 100
        summary_parts.append(f"{c}: ${country_spend[c]:.2f} ({pct:.1f}%)")
    spend_summary = " | ".join(summary_parts)
else:
    spend_summary = "No spend data"

if clean:
    msg = f"✅ *Geo Audit — All Clear*\nAll active ad sets targeting approved markets only (US, CA). Last 7d spend: {spend_summary}"
else:
    msg = "🚨 *Geo Audit — Issues Found*\n" + "\n".join(alerts) + f"\nSpend breakdown: {spend_summary}"

print(msg)
PYEOF
