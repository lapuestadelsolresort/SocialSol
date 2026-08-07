#!/usr/bin/env python3
"""Shared, window-aligned campaign measurement helpers."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from campaign_registry import graph_api

LA = ZoneInfo("America/Los_Angeles")


def utc_window(start_day, end_day=None):
    """Return a half-open UTC window for inclusive Los Angeles calendar days."""
    start = datetime.strptime(start_day, "%Y-%m-%d").replace(tzinfo=LA)
    end = datetime.strptime(end_day or start_day, "%Y-%m-%d").replace(tzinfo=LA) + timedelta(days=1)
    return (
        start.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        end.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
    )


def _action(row, name):
    return int(float(next((item.get("value", 0) for item in row.get("actions") or []
                           if item.get("action_type") == name), 0)))


def meta_metrics(secrets, campaigns, start_day, end_day=None):
    """Fetch exact-date Meta delivery metrics for canonical campaign IDs."""
    metrics = {}
    date_range = json.dumps({"since": start_day, "until": end_day or start_day})
    for campaign in campaigns:
        cid = str(campaign["campaign_id"])
        payload = graph_api(
            secrets,
            f"{cid}/insights",
            fields="campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,frequency,actions",
            time_range=date_range,
            level="campaign",
        )
        row = (payload.get("data") or [{}])[0]
        metrics[cid] = {
            "spend": float(row.get("spend") or 0),
            "impressions": int(row.get("impressions") or 0),
            "clicks": int(row.get("clicks") or 0),
            "link_clicks": _action(row, "link_click"),
            "landing_page_views": _action(row, "landing_page_view"),
            # This remains diagnostic only: old browser Lead events were tap proxies.
            "meta_reported_leads": _action(row, "lead"),
            "ctr": float(row.get("ctr") or 0),
            "cpc": float(row.get("cpc") or 0),
            "frequency": float(row.get("frequency") or 0),
        }
    return metrics


def _tag_clause(tags):
    tags = sorted({str(tag) for tag in tags if tag})
    if not tags:
        return "0", []
    return f"utm_campaign IN ({','.join('?' for _ in tags)})", tags


def crm_metrics(db_path, campaigns, start_day, end_day=None):
    """Measure sessions, tracked taps, and verified inbound leads by UTM set."""
    start_utc, end_utc = utc_window(start_day, end_day)
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"page_sessions", "page_events", "leads", "attribution_events"}
        missing = required - tables
        if missing:
            raise RuntimeError(f"CRM schema missing: {', '.join(sorted(missing))}")

        output = {}
        for campaign in campaigns:
            cid = str(campaign["campaign_id"])
            clause, tags = _tag_clause(campaign.get("utm_tags") or [])
            window = [start_utc, end_utc]
            session = con.execute(
                f"""SELECT COUNT(*) sessions,
                           COALESCE(SUM(CASE WHEN max_scroll_pct > 0 OR reached_cta=1 OR dwell_ms>=10000 THEN 1 ELSE 0 END),0) qualified,
                           COALESCE(SUM(reached_cta),0) cta_reached,
                           COALESCE(SUM(cta_clicked),0) wa_taps
                    FROM page_sessions
                    WHERE is_bot=0 AND created_at>=? AND created_at<? AND {clause}""",
                window + tags,
            ).fetchone()
            event_sessions = con.execute(
                f"""SELECT COUNT(DISTINCT ps.id)
                    FROM page_sessions ps JOIN page_events pe ON pe.session_id=ps.id
                    WHERE ps.is_bot=0 AND ps.created_at>=? AND ps.created_at<?
                      AND pe.kind!='pageview' AND {clause.replace('utm_campaign', 'ps.utm_campaign')}""",
                window + tags,
            ).fetchone()[0]
            verified = con.execute(
                f"""SELECT COUNT(DISTINCT ae.lead_id)
                    FROM attribution_events ae
                    WHERE ae.event_type='whatsapp_lead'
                      AND ae.created_at>=? AND ae.created_at<?
                      AND {clause.replace('utm_campaign', 'ae.utm_campaign')}""",
                window + tags,
            ).fetchone()[0]
            output[cid] = {
                "sessions": int(session["sessions"]),
                "qualified": int(session["qualified"]),
                "cta_reached": int(session["cta_reached"]),
                "wa_taps": int(session["wa_taps"]),
                "sessions_with_behavior": int(event_sessions),
                "verified_wa_leads": int(verified),
            }
        return output
    finally:
        con.close()


def unattributed_verified_leads(db_path, start_day, end_day=None):
    start_utc, end_utc = utc_window(start_day, end_day)
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return int(con.execute(
            """SELECT COUNT(*) FROM leads l
               WHERE l.source IN ('whatsapp','meta_ad')
                 AND l.created_at>=? AND l.created_at<?
                 AND NOT EXISTS (
                   SELECT 1 FROM attribution_events ae
                   WHERE ae.lead_id=l.id AND ae.event_type='whatsapp_lead'
                 )""",
            (start_utc, end_utc),
        ).fetchone()[0])
    finally:
        con.close()
