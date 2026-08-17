#!/usr/bin/env python3
"""Read-only Slack scanning for the weekly accounting control.

The receipt-coverage and checkmark-reconciliation checks have to see what is
actually sitting in the receipt channels, not what the accounting pipeline
already ingested: a receipt the pipeline never picked up is precisely the
failure those checks exist to catch, so reconciling the pipeline's own
projection against QBO would miss it by construction.

Reads go through the same sanctioned `openclaw message` CLI the jobs already
use to post. A read returns messages newest-first carrying `ts`, `text`,
`files` and `reactions` inline, plus `hasMore`; `--before <ts>` pages strictly
older. Nothing in this module writes to Slack.
"""

import json
import os
import subprocess
import tempfile

DEFAULT_OPENCLAW_BIN = "/opt/homebrew/bin/openclaw"
PAGE_LIMIT = 200
MAX_PAGES = 40
CHECKMARK = "white_check_mark"


class SlackScanError(RuntimeError):
    """A Slack read could not be completed, or its result cannot be trusted."""


def _openclaw_bin():
    return os.environ.get("OPENCLAW_BIN", DEFAULT_OPENCLAW_BIN)


def _read_page(args, runner):
    """Run one `openclaw message read` and return its payload.

    Output goes to a temp file rather than a pipe: the CLI exits without
    draining a piped stdout, so a channel page over ~64 KB comes back as
    truncated JSON. Writes to a file are synchronous and arrive whole.
    """
    with tempfile.NamedTemporaryFile("w+", suffix=".json", delete=False) as handle:
        capture_path = handle.name
    try:
        with open(capture_path, "w", encoding="utf-8") as sink:
            try:
                completed = runner(
                    args, stdout=sink, stderr=subprocess.PIPE, text=True, timeout=90
                )
            except subprocess.TimeoutExpired as exc:
                raise SlackScanError("openclaw read timed out") from exc
        if completed.returncode != 0:
            detail = (completed.stderr or "").strip()
            raise SlackScanError(
                f"openclaw read exited {completed.returncode}: {detail[:200]}"
            )
        raw = getattr(completed, "stdout", None)
        if not raw:
            with open(capture_path, encoding="utf-8") as source:
                raw = source.read()
        try:
            payload = json.loads(raw)["payload"]
        except (ValueError, KeyError, TypeError) as exc:
            raise SlackScanError(f"unreadable openclaw response: {exc}") from exc
        if not payload.get("ok"):
            raise SlackScanError(f"slack read reported not-ok: {str(payload)[:200]}")
        return payload
    finally:
        try:
            os.unlink(capture_path)
        except OSError:
            pass


def read_channel_since(
    channel_id,
    since_ts,
    *,
    account,
    openclaw_bin=None,
    page_limit=PAGE_LIMIT,
    max_pages=MAX_PAGES,
    runner=subprocess.run,
):
    """Every message in `channel_id` strictly newer than `since_ts`.

    Raises SlackScanError if the window cannot be covered inside `max_pages`.
    A partial scan is never returned as if it were complete — reporting a
    capped read as a full one is the exact defect this control was rebuilt to
    stop doing.
    """
    binary = openclaw_bin or _openclaw_bin()
    collected = []
    before = None
    for _ in range(max_pages):
        args = [
            binary, "message", "read",
            "--channel", "slack",
            "--account", account,
            "--target", f"channel:{channel_id}",
            "--limit", str(page_limit),
            "--json",
        ]
        if before:
            args += ["--before", before]
        payload = _read_page(args, runner)
        messages = payload.get("messages") or []
        if not messages:
            return collected
        for message in messages:
            try:
                stamp = float(message.get("ts", 0))
            except (TypeError, ValueError):
                continue
            if stamp <= since_ts:
                return collected
            collected.append(message)
        if not payload.get("hasMore"):
            return collected
        before = messages[-1].get("ts")
        if not before:
            return collected
    raise SlackScanError(
        f"channel {channel_id} window not covered within {max_pages} pages"
    )


def receipt_candidates(messages):
    """Human-posted messages carrying an attachment — a receipt as posted.

    Bot messages are the pipeline talking about receipts, not receipts.
    """
    return [m for m in messages if not m.get("bot_id") and m.get("files")]


def has_reaction(message, name=CHECKMARK):
    return any(r.get("name") == name for r in (message.get("reactions") or []))


def message_ts(message):
    try:
        return float(message.get("ts", 0))
    except (TypeError, ValueError):
        return 0.0
