#!/usr/bin/env python3
"""Conversational Slack approval receipts for paid campaign activation."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from campaign_registry import REGISTRY_PATH, load_registry, write_registry

ROOT = Path(__file__).resolve().parent.parent
OPENCLAW = os.environ.get("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw")
SLACK_ACCOUNT = os.environ.get("OPENCLAW_SLACK_ACCOUNT", "")
SOCIAL_CHANNEL_ID = os.environ.get("RESORT_SOCIAL_CHANNEL", "")
APPROVER_USER_ID = os.environ.get("CAMPAIGN_APPROVER_SLACK_USER_ID", "")


class ApprovalError(RuntimeError):
    pass


def _messages(payload):
    if not isinstance(payload, dict):
        return []
    if isinstance(payload.get("messages"), list):
        return payload["messages"]
    if isinstance(payload.get("payload"), dict):
        return _messages(payload["payload"])
    return []


def verify_slack_message(payload, *, slack_ts, approver_user_id, request_ts=None):
    """Validate a Slack API/OpenClaw read payload and return an approval receipt."""
    wanted = str(slack_ts)
    message = next((row for row in _messages(payload) if str(row.get("ts") or row.get("id")) == wanted), None)
    if not message:
        raise ApprovalError("approval slack_ts did not resolve to a message")
    actual_user = str(message.get("user") or message.get("user_id") or "")
    if actual_user != str(approver_user_id):
        raise ApprovalError("approval message was not authored by the configured approver")
    if message.get("bot_id") or message.get("app_id"):
        raise ApprovalError("bot/app messages cannot approve paid spend")
    text = str(message.get("text") or "").strip()
    if not text:
        raise ApprovalError("approval message is empty")
    if request_ts:
        thread_ts = str(message.get("thread_ts") or "")
        if thread_ts != str(request_ts):
            raise ApprovalError("approval message is not a reply to the campaign request")
        try:
            if float(wanted) <= float(request_ts):
                raise ApprovalError("approval message predates the campaign request")
        except ValueError:
            pass
    return {
        "approved_by_user_id": actual_user,
        "slack_ts": wanted,
        "quoted_text": text,
        "approval_request_ts": str(request_ts) if request_ts else None,
    }


def read_slack_message(channel_id, slack_ts, account=None, openclaw=OPENCLAW, thread_ts=None):
    account = account or SLACK_ACCOUNT
    if not channel_id or not account:
        raise ApprovalError("Slack channel/account is not configured")
    cmd = [
        openclaw, "message", "read", "--channel", "slack", "--account", account,
        "--target", f"channel:{channel_id}", "--message-id", str(slack_ts), "--json",
    ]
    if thread_ts:
        cmd.extend(["--thread-id", str(thread_ts)])
    try:
        result = subprocess.run(cmd, check=True, timeout=30, capture_output=True, text=True)
        return json.loads(result.stdout)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as exc:
        raise ApprovalError(f"could not resolve approval message: {exc}") from exc


def verify_registry_approval(record, *, channel_id=None, approver_user_id=None, account=None):
    approval = record.get("approval") or {}
    channel_id = channel_id or SOCIAL_CHANNEL_ID
    approver_user_id = approver_user_id or APPROVER_USER_ID
    if not channel_id or not approver_user_id:
        raise ApprovalError("approval channel and approver identity must be configured")
    if str(approval.get("slack_channel") or "") != str(channel_id):
        raise ApprovalError("registry approval channel does not match the configured channel")
    slack_ts = approval.get("slack_ts")
    if not slack_ts:
        raise ApprovalError("registry approval is missing slack_ts")
    request_ts = approval.get("approval_request_ts")
    payload = read_slack_message(channel_id, slack_ts, account=account, thread_ts=request_ts)
    verified = verify_slack_message(
        payload,
        slack_ts=slack_ts,
        approver_user_id=approver_user_id,
        request_ts=request_ts,
    )
    if verified["quoted_text"] != str(approval.get("quoted_text") or ""):
        raise ApprovalError("stored quoted_text does not match Slack")
    if verified["approved_by_user_id"] != str(approval.get("approved_by_user_id") or ""):
        raise ApprovalError("stored approver identity does not match Slack")
    return {**approval, "verified_at": datetime.now(timezone.utc).isoformat()}


def record_approval(
    records,
    *,
    brief_id,
    channel_id,
    slack_ts,
    approver_user_id,
    approved_by,
    request_ts=None,
    account=None,
):
    payload = read_slack_message(channel_id, slack_ts, account=account, thread_ts=request_ts)
    verified = verify_slack_message(
        payload,
        slack_ts=slack_ts,
        approver_user_id=approver_user_id,
        request_ts=request_ts,
    )
    found = False
    updated = []
    for original in records:
        row = dict(original)
        if row.get("brief_id") == brief_id:
            found = True
            row["approval"] = {
                "approved_by": approved_by,
                "approved_by_user_id": verified["approved_by_user_id"],
                "slack_channel": channel_id,
                "approval_request_ts": verified.get("approval_request_ts"),
                "slack_ts": verified["slack_ts"],
                "quoted_text": verified["quoted_text"],
                "verified_at": datetime.now(timezone.utc).isoformat(),
            }
        updated.append(row)
    if not found:
        raise ApprovalError(f"brief_id {brief_id!r} is not registered")
    return updated


def bind_approval_request(records, *, brief_id, channel_id, request_ts, account=None):
    payload = read_slack_message(channel_id, request_ts, account=account)
    message = next((row for row in _messages(payload) if str(row.get("ts") or row.get("id")) == str(request_ts)), None)
    if not message:
        raise ApprovalError("approval request slack_ts did not resolve to a message")
    text = str(message.get("text") or "")
    if brief_id not in text:
        raise ApprovalError("approval request does not identify the brief_id")
    found = False
    updated = []
    for original in records:
        row = dict(original)
        if row.get("brief_id") == brief_id:
            found = True
            row["approval_request"] = {
                "slack_channel": channel_id,
                "slack_ts": str(request_ts),
                "text": text,
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }
        updated.append(row)
    if not found:
        raise ApprovalError(f"brief_id {brief_id!r} is not registered")
    return updated


def main():
    parser = argparse.ArgumentParser(description="Record or verify a real Slack campaign approval")
    parser.add_argument("action", choices=("bind-request", "record", "verify"))
    parser.add_argument("--brief-id", required=True)
    parser.add_argument("--registry", default=str(REGISTRY_PATH))
    parser.add_argument("--channel-id", default=SOCIAL_CHANNEL_ID)
    parser.add_argument("--approver-user-id", default=APPROVER_USER_ID)
    parser.add_argument("--approved-by", default="Jason Starkey")
    parser.add_argument("--slack-ts")
    parser.add_argument("--request-ts")
    parser.add_argument("--account", default=SLACK_ACCOUNT)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    records = load_registry(args.registry)
    record = next((row for row in records if row.get("brief_id") == args.brief_id), None)
    if not record:
        raise ApprovalError(f"brief_id {args.brief_id!r} is not registered")

    if args.action == "bind-request":
        if not args.request_ts:
            parser.error("bind-request requires --request-ts")
        updated = bind_approval_request(
            records,
            brief_id=args.brief_id,
            channel_id=args.channel_id,
            request_ts=args.request_ts,
            account=args.account,
        )
        if args.apply:
            write_registry(updated, args.registry)
        request = next(row["approval_request"] for row in updated if row.get("brief_id") == args.brief_id)
        print(json.dumps({"ok": True, "applied": args.apply, "brief_id": args.brief_id, "approval_request": request}, indent=2))
        return

    if args.action == "verify":
        receipt = verify_registry_approval(
            record,
            channel_id=args.channel_id,
            approver_user_id=args.approver_user_id,
            account=args.account,
        )
        print(json.dumps({"ok": True, "brief_id": args.brief_id, "approval": receipt}, indent=2))
        return

    if not args.slack_ts:
        parser.error("record requires --slack-ts")
    request_ts = args.request_ts or (record.get("approval_request") or {}).get("slack_ts")
    updated = record_approval(
        records,
        brief_id=args.brief_id,
        channel_id=args.channel_id,
        slack_ts=args.slack_ts,
        approver_user_id=args.approver_user_id,
        approved_by=args.approved_by,
        request_ts=request_ts,
        account=args.account,
    )
    if args.apply:
        write_registry(updated, args.registry)
    receipt = next(row["approval"] for row in updated if row.get("brief_id") == args.brief_id)
    print(json.dumps({"ok": True, "applied": args.apply, "brief_id": args.brief_id, "approval": receipt}, indent=2))


if __name__ == "__main__":
    main()
