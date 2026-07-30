#!/bin/bash
# Starts the named Cloudflare Tunnel for the CRM webhook.
#
# The named tunnel and hostname are configured out-of-band in Cloudflare.
#
# This replaces the prior quick-tunnel script (saved as start-tunnel.sh.quick-tunnel.bak).
# A named tunnel keeps a stable hostname across restarts, so the Squarespace
# inquiry pixel/form (hardcoded against webhook.lapuestadelsolresort.com),
# Resend webhook, and prospector unsubscribe URLs all keep routing without
# reconfiguration after every reboot.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOCIALSOL_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
URL_FILE="${TUNNEL_URL_FILE:-${REPO_ROOT}/crm/data/tunnel-url.txt}"
STABLE_URL="${PUBLIC_CRM_ORIGIN:-https://webhook.lapuestadelsolresort.com}"
TUNNEL_NAME="${CLOUDFLARE_TUNNEL_NAME:-lapuestadelsol-crm}"

# Stable hostname is configured in ~/.cloudflared/config.yml — write it for
# tunnel-heartbeat.sh and any other consumer that reads tunnel-url.txt.
echo "$STABLE_URL" > "$URL_FILE"

# Run the named tunnel in the foreground (LaunchAgent owns the process lifecycle).
# `cloudflared tunnel run` only takes the tunnel name as a positional arg;
# stdout/stderr are captured by the LaunchAgent's StandardOutPath.
exec "${CLOUDFLARED_BIN:-/opt/homebrew/bin/cloudflared}" --loglevel info tunnel run "$TUNNEL_NAME"
