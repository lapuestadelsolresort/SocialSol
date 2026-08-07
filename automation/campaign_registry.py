#!/usr/bin/env python3
"""Canonical campaign registry helpers backed by live Meta state.

The runtime registry remains a JSON array for backward compatibility, but every
consumer uses grouped campaign records and the full set of live ad destinations
and UTM aliases. Meta is the source of truth for delivery status and budgets.
"""

from __future__ import annotations

import json
import os
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REGISTRY_PATH = ROOT / "campaigns" / "active-campaigns.json"
SECRETS_DIR = Path(os.environ.get("SOCIALSOL_SECRETS_DIR", ROOT / "secrets"))
META_SECRETS_PATH = SECRETS_DIR / "meta.json"


class MetaAPIError(RuntimeError):
    pass


def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def load_registry(path=REGISTRY_PATH):
    raw = load_json(path, [])
    if isinstance(raw, dict):
        raw = raw.get("campaigns", [])
    if not isinstance(raw, list):
        raise ValueError("campaign registry must be an array or an object with campaigns[]")
    return raw


def write_registry(records, path=REGISTRY_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".active-campaigns-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(records, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def load_meta_secrets(path=META_SECRETS_PATH):
    data = load_json(path, {})
    if not isinstance(data, dict) or not data.get("access_token"):
        raise MetaAPIError("Meta credentials are not configured")
    if not data.get("ad_account_act"):
        account_id = str(data.get("ad_account_id") or "").removeprefix("act_")
        if account_id:
            data["ad_account_act"] = f"act_{account_id}"
    return data


def graph_version(secrets):
    return str(secrets.get("graph_api_version") or secrets.get("graph_version") or "v21.0")


def graph_api(secrets, endpoint, **params):
    base = str(secrets.get("graph_api_base") or "https://graph.facebook.com").rstrip("/")
    base_path = urllib.parse.urlsplit(base).path.rstrip("/")
    versioned = base_path.rsplit("/", 1)[-1].startswith("v") and base_path.rsplit("/", 1)[-1][1:2].isdigit()
    url = f"{base}/{endpoint.lstrip('/')}" if versioned else f"{base}/{graph_version(secrets)}/{endpoint.lstrip('/')}"
    if params:
        url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {secrets['access_token']}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise MetaAPIError(f"Meta API request failed for {endpoint}: {exc}") from exc
    if payload.get("error"):
        error = payload["error"]
        raise MetaAPIError(f"Meta API error for {endpoint}: {error.get('message', 'unknown')}")
    return payload


URL_KEYS = {"link", "link_url", "website_url"}


def _creative_urls(value, key=None):
    found = []
    if isinstance(value, dict):
        for child_key, child in value.items():
            found.extend(_creative_urls(child, child_key))
    elif isinstance(value, list):
        for child in value:
            found.extend(_creative_urls(child, key))
    elif isinstance(value, str) and key in URL_KEYS and value.startswith(("http://", "https://")):
        found.append(value)
    return found


def _destination(url, url_tags=None):
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parsed.query)
    tags = urllib.parse.parse_qs(url_tags or "")

    def first(name):
        return (query.get(name) or tags.get(name) or [None])[0]

    host = (parsed.hostname or "").lower()
    if host == "lapuestadelsolresort.com" or host == "www.lapuestadelsolresort.com":
        tracker = "sq-tracker"
        page_slug = "main-site"
    else:
        page_slug = host.split(".", 1)[0] if host.endswith(".lapuestadelsolresort.com") else None
        tracker = "px" if page_slug else "unknown"
    return {
        "url": url,
        "host": host,
        "path": parsed.path or "/",
        "page_slug": page_slug,
        "tracker": tracker,
        "utm_source": first("utm_source"),
        "utm_medium": first("utm_medium"),
        "utm_campaign": first("utm_campaign"),
        "utm_content": first("utm_content"),
    }


def fetch_live_snapshot(records=None, secrets=None):
    """Return live Meta campaign/ad destinations for configured LPDS campaigns."""
    records = records if records is not None else load_registry()
    secrets = secrets or load_meta_secrets()
    act = secrets["ad_account_act"]
    payload = graph_api(
        secrets,
        f"{act}/campaigns",
        fields="id,name,status,effective_status,daily_budget,lifetime_budget,objective,updated_time",
        limit="100",
    )
    meta_campaigns = {str(row["id"]): row for row in payload.get("data", [])}
    configured_ids = {str(row.get("campaign_id")) for row in records if row.get("campaign_id")}
    relevant_ids = configured_ids | {
        cid for cid, row in meta_campaigns.items()
        if str(row.get("name") or "").startswith("LPDS") and row.get("effective_status") == "ACTIVE"
    }

    snapshot = []
    for cid in sorted(relevant_ids):
        campaign = meta_campaigns.get(cid)
        if not campaign:
            try:
                campaign = graph_api(
                    secrets,
                    cid,
                    fields="id,name,status,effective_status,daily_budget,lifetime_budget,objective,updated_time",
                )
            except MetaAPIError:
                campaign = {"id": cid, "status": "UNKNOWN", "effective_status": "UNKNOWN"}

        ads_payload = graph_api(
            secrets,
            f"{cid}/ads",
            fields="id,name,status,effective_status,adset_id,creative{id,name,object_story_spec,asset_feed_spec,url_tags}",
            limit="100",
        )
        active_ads = [row for row in ads_payload.get("data", []) if row.get("effective_status") == "ACTIVE"]
        destinations = []
        for ad in active_ads:
            creative = ad.get("creative") or {}
            seen = set()
            for url in _creative_urls(creative):
                dest = _destination(url, creative.get("url_tags"))
                key = (ad.get("id"), dest["url"], dest.get("utm_campaign"))
                if key in seen:
                    continue
                seen.add(key)
                dest.update({"ad_id": str(ad.get("id") or ""), "ad_name": ad.get("name")})
                destinations.append(dest)

        configured = [row for row in records if str(row.get("campaign_id") or "") == cid]
        configured_tags = {
            str(tag) for row in configured
            for tag in [row.get("utm_campaign"), *(row.get("utm_aliases") or [])]
            if tag
        }
        live_tags = {str(row["utm_campaign"]) for row in destinations if row.get("utm_campaign")}
        daily_budget = campaign.get("daily_budget")
        snapshot.append({
            "campaign_id": cid,
            "campaign_name": campaign.get("name") or (configured[0].get("campaign_name") if configured else cid),
            "status": campaign.get("status") or "UNKNOWN",
            "effective_status": campaign.get("effective_status") or "UNKNOWN",
            "objective": campaign.get("objective"),
            "updated_time": campaign.get("updated_time"),
            "daily_budget_usd": (int(daily_budget) / 100.0) if daily_budget else None,
            "configured": bool(configured),
            "adset_ids": sorted({str(row.get("adset_id")) for row in configured if row.get("adset_id")}),
            "active_ad_count": len(active_ads),
            "destinations": destinations,
            "utm_tags": sorted(live_tags or configured_tags),
        })
    return snapshot


def group_registry(records=None, active_only=False):
    """Group duplicate ad-set records into one campaign measurement definition."""
    records = records if records is not None else load_registry()
    groups = {}
    for row in records:
        cid = str(row.get("campaign_id") or "").strip()
        if not cid:
            continue
        group = groups.setdefault(cid, {
            "campaign_id": cid,
            "campaign_name": row.get("campaign_name") or cid,
            "status": row.get("meta_effective_status") or row.get("status") or "UNKNOWN",
            "daily_budget_usd": row.get("campaign_daily_budget_usd", row.get("daily_budget_usd")),
            "adset_ids": set(),
            "page_slugs": set(),
            "utm_tags": set(),
            "destinations": [],
            "records": [],
        })
        group["records"].append(row)
        group["status"] = row.get("meta_effective_status") or row.get("status") or group["status"]
        if row.get("adset_id"):
            group["adset_ids"].add(str(row["adset_id"]))
        if row.get("page_slug"):
            group["page_slugs"].add(str(row["page_slug"]))
        for tag in [row.get("utm_campaign"), *(row.get("utm_aliases") or [])]:
            if tag:
                group["utm_tags"].add(str(tag))
        for destination in row.get("destinations") or []:
            if destination not in group["destinations"]:
                group["destinations"].append(destination)
            if destination.get("utm_campaign"):
                group["utm_tags"].add(str(destination["utm_campaign"]))
            if destination.get("page_slug"):
                group["page_slugs"].add(str(destination["page_slug"]))

    output = []
    for group in groups.values():
        group["adset_ids"] = sorted(group["adset_ids"])
        group["page_slugs"] = sorted(group["page_slugs"])
        group["utm_tags"] = sorted(group["utm_tags"])
        if not active_only or group["status"] == "ACTIVE":
            output.append(group)
    return sorted(output, key=lambda row: row["campaign_name"])


def apply_snapshot(records, snapshot, reconciled_at):
    by_id = {str(row["campaign_id"]): row for row in snapshot}
    updated = []
    for original in records:
        row = dict(original)
        live = by_id.get(str(row.get("campaign_id") or ""))
        if live:
            row["status"] = live["effective_status"]
            row["meta_status"] = live["status"]
            row["meta_effective_status"] = live["effective_status"]
            row["meta_reconciled_at"] = reconciled_at
            row["active_ad_count"] = live["active_ad_count"]
            row["destinations"] = live["destinations"]
            row["utm_aliases"] = [tag for tag in live["utm_tags"] if tag != row.get("utm_campaign")]
            if live.get("daily_budget_usd") is not None and row.get("budget_level") == "campaign":
                row["campaign_daily_budget_usd"] = live["daily_budget_usd"]
        updated.append(row)
    return updated
