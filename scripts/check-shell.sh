#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(
  find "$ROOT" \
    -type d \( -name node_modules -o -name dist -o -name cache -o -name runs \) -prune \
    -o -type f -name '*.sh' -print0
)

echo "Shell syntax checks passed."
