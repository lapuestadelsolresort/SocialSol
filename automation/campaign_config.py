"""Pure campaign configuration builders and Meta read-back comparisons."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy

# Volatile bookkeeping fields the CLI writes into a brief after activation.
# They are excluded from the review hash so an approval binds to the reviewed
# creative/targeting content, not to lifecycle metadata.
REVIEW_HASH_EXCLUDED_FIELDS = ("status", "activated_at")


def stable_brief_hash(brief):
    """Content hash an approval receipt binds to (F-001 review invariant)."""
    normalized = {
        key: value for key, value in brief.items()
        if key not in REVIEW_HASH_EXCLUDED_FIELDS
    }
    payload = json.dumps(normalized, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _ids(items):
    return sorted(str(item.get("id")) for item in (items or []) if item.get("id"))


def _flatten_detailed(targeting, field):
    values = []
    for spec in targeting.get("flexible_spec") or []:
        values.extend(spec.get(field) or [])
    values.extend(targeting.get(field) or [])
    return _ids(values)


def build_targeting(brief):
    audience = brief["audience"]
    if audience.get("regions"):
        geo_locations = {
            "regions": [
                {"key": str(row["key"]), "name": row.get("name"), "country": row.get("country")}
                for row in audience["regions"]
            ],
            "location_types": list(audience.get("location_types") or ["home", "recent"]),
        }
    else:
        geo_locations = {
            "countries": list(audience["countries"]),
            "location_types": list(audience.get("location_types") or ["home", "recent"]),
        }
    targeting = {
        "age_min": int(audience.get("age_min", 18)),
        "age_max": int(audience.get("age_max", 65)),
        "geo_locations": geo_locations,
        # An explicit empty list means "all placements" (mirrors live adsets
        # created without a placement restriction); an absent key keeps the
        # historical facebook+instagram default.
        "publisher_platforms": (
            list(audience["publisher_platforms"]) if "publisher_platforms" in audience
            else ["facebook", "instagram"]
        ),
        "targeting_automation": {"advantage_audience": 1 if audience.get("expansion") else 0},
    }
    detailed = {}
    for field in ("interests", "behaviors", "work_positions"):
        if audience.get(field):
            detailed[field] = deepcopy(audience[field])
    if detailed:
        targeting["flexible_spec"] = [detailed]
    custom_ids = [str(value) for value in audience.get("custom_audience_ids") or []]
    if custom_ids:
        targeting["custom_audiences"] = [{"id": value} for value in custom_ids]
    if audience.get("expansion") is False:
        targeting["targeting_relaxation_types"] = {"custom_audience": 0, "lookalike": 0}
    return targeting


def _creative_links(value, key=None):
    links = []
    if isinstance(value, dict):
        for child_key, child in value.items():
            links.extend(_creative_links(child, child_key))
    elif isinstance(value, list):
        for child in value:
            links.extend(_creative_links(child, key))
    elif isinstance(value, str) and key in {"link", "link_url", "website_url"}:
        links.append(value)
    return sorted(set(links))


def compare_brief_to_live(brief, live, require_active=False):
    """Return semantic drift entries. Empty means the live objects match."""
    campaign = live.get("campaign") or {}
    adset = live.get("adset") or {}
    ad = live.get("ad") or {}
    creative = live.get("creative") or ad.get("creative") or {}
    brief_ads = brief.get("ads") if isinstance(brief.get("ads"), list) else None
    actual_targeting = adset.get("targeting") or {}
    expected_targeting = build_targeting(brief)
    diffs = []

    def check(field, expected, actual):
        if expected != actual:
            diffs.append({"field": field, "expected": expected, "actual": actual})

    check("campaign.name", brief["campaign_name"], campaign.get("name"))
    check("campaign.objective", brief["objective"], campaign.get("objective"))
    check(
        "campaign.daily_budget_cents",
        int(round(float(brief["campaign_daily_budget_usd"]) * 100)),
        int(campaign.get("daily_budget") or 0),
    )
    check("adset.optimization_goal", brief["optimization_goal"], adset.get("optimization_goal"))
    expected_geo = expected_targeting["geo_locations"]
    actual_geo = actual_targeting.get("geo_locations") or {}
    if "regions" in expected_geo:
        check(
            "targeting.regions",
            sorted(str(row.get("key")) for row in expected_geo["regions"]),
            sorted(str(row.get("key")) for row in actual_geo.get("regions") or []),
        )
        check("targeting.countries", [], sorted(actual_geo.get("countries") or []))
    else:
        check(
            "targeting.countries",
            sorted(expected_geo["countries"]),
            sorted(actual_geo.get("countries") or []),
        )
    check("targeting.age_min", expected_targeting["age_min"], int(actual_targeting.get("age_min") or 0))
    check("targeting.age_max", expected_targeting["age_max"], int(actual_targeting.get("age_max") or 0))
    check(
        "targeting.publisher_platforms",
        sorted(expected_targeting["publisher_platforms"]),
        sorted(actual_targeting.get("publisher_platforms") or []),
    )
    for field in ("interests", "behaviors", "work_positions"):
        check(
            f"targeting.{field}",
            _flatten_detailed(expected_targeting, field),
            _flatten_detailed(actual_targeting, field),
        )
    check(
        "targeting.custom_audiences",
        sorted(str(value) for value in brief["audience"].get("custom_audience_ids") or []),
        _ids(actual_targeting.get("custom_audiences")),
    )
    expected_expansion = 1 if brief["audience"].get("expansion") else 0
    # An adset with no targeting_automation block has Advantage Audience off;
    # only an explicit flag can differ from 0.
    actual_expansion = int((actual_targeting.get("targeting_automation") or {}).get("advantage_audience", 0) or 0)
    check("targeting.advantage_audience", expected_expansion, actual_expansion)
    if not expected_expansion:
        relaxation = actual_targeting.get("targeting_relaxation_types") or {}
        check("targeting.custom_audience_relaxation", 0, int(relaxation.get("custom_audience") or 0))
    if brief_ads is not None:
        live_ads = live.get("ads") or []
        live_creatives = live.get("creatives") or []
        check("adset.ad_count", len(brief_ads), len(live_ads))
        expected_links = sorted({
            str(row.get("landing_page_url") or "") for row in brief_ads
        })
        actual_links = sorted({
            link for row in live_creatives for link in _creative_links(row)
        })
        check("creative.links", expected_links, actual_links)
        if require_active:
            check("campaign.effective_status", "ACTIVE", campaign.get("effective_status"))
            check("adset.effective_status", "ACTIVE", adset.get("effective_status"))
            for live_ad in live_ads:
                check(
                    f"ad.{live_ad.get('id')}.effective_status",
                    "ACTIVE",
                    live_ad.get("effective_status"),
                )
    else:
        expected_links = [brief["landing_page_url"]]
        check("creative.links", expected_links, _creative_links(creative))
        if require_active:
            check("campaign.effective_status", "ACTIVE", campaign.get("effective_status"))
            check("adset.effective_status", "ACTIVE", adset.get("effective_status"))
            check("ad.effective_status", "ACTIVE", ad.get("effective_status"))
    return diffs


def build_clean_audience_rule(audience):
    retention_seconds = int(audience.get("retention_days", 180)) * 86400
    event_sources = [{"id": int(audience["pixel_id"]), "type": "pixel"}]
    rule = {
        "inclusions": {
            "operator": "or",
            "rules": [{
                "event_sources": event_sources,
                "retention_seconds": retention_seconds,
                "filter": {
                    "operator": "and",
                    "filters": [{"field": "url", "operator": "i_contains", "value": audience["url_contains"]}],
                },
            }],
        }
    }
    excluded = sorted(set(audience.get("excluded_utm_campaigns") or []))
    if excluded:
        rule["exclusions"] = {
            "operator": "or",
            "rules": [{
                "event_sources": event_sources,
                "retention_seconds": retention_seconds,
                "filter": {
                    "operator": "or",
                    "filters": [
                        {"field": "url", "operator": "i_contains", "value": f"utm_campaign={slug}"}
                        for slug in excluded
                    ],
                },
            }],
        }
    return rule


def audience_rule_summary(rule):
    if isinstance(rule, str):
        rule = json.loads(rule)
    values = {
        "included_urls": [],
        "excluded_urls": [],
        "pixel_ids": [],
        "retention_seconds": [],
    }

    def collect(section, target):
        for entry in (rule.get(section) or {}).get("rules") or []:
            values["retention_seconds"].append(int(entry.get("retention_seconds") or 0))
            for source in entry.get("event_sources") or []:
                if source.get("type") == "pixel" and source.get("id") is not None:
                    values["pixel_ids"].append(str(source["id"]))
            for item in (entry.get("filter") or {}).get("filters") or []:
                if item.get("field") == "url" and item.get("operator") == "i_contains":
                    target.append(str(item.get("value") or ""))

    collect("inclusions", values["included_urls"])
    collect("exclusions", values["excluded_urls"])
    return {key: sorted(set(value)) for key, value in values.items()}
