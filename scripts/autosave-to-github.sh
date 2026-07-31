#!/usr/bin/env bash
set -euo pipefail

# Snapshot every Git-eligible working-tree file to a dedicated remote branch
# without changing the active branch, working tree, or real Git index.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${SOCIALSOL_AUTOSAVE_REMOTE:-origin}"
BRANCH="${SOCIALSOL_AUTOSAVE_BRANCH:-autosave/macmini}"
MAX_FILE_BYTES="${SOCIALSOL_AUTOSAVE_MAX_FILE_BYTES:-10485760}"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
umask 077

git_at_root() {
  git -C "$ROOT" "$@"
}

if ! git_at_root rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $ROOT is not a Git working tree" >&2
  exit 1
fi

if ! git_at_root remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "ERROR: Git remote '$REMOTE' is not configured" >&2
  exit 1
fi

if ! [[ "$MAX_FILE_BYTES" =~ ^[0-9]+$ ]] || [[ "$MAX_FILE_BYTES" -lt 1 ]]; then
  echo "ERROR: SOCIALSOL_AUTOSAVE_MAX_FILE_BYTES must be a positive integer" >&2
  exit 2
fi

CURRENT_BRANCH="$(git_at_root branch --show-current)"
if [[ "$CURRENT_BRANCH" == "$BRANCH" ]]; then
  echo "ERROR: refusing to run while the protected autosave branch is checked out" >&2
  exit 1
fi

GIT_DIR="$(git_at_root rev-parse --absolute-git-dir)"
LOCK_DIR="$GIT_DIR/socialsol-autosave.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Autosave already running; skipping."
  exit 0
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/socialsol-autosave.XXXXXX")"
ALT_INDEX="$TEMP_DIR/index"
cleanup() {
  rm -rf "$TEMP_DIR"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$ROOT"

# Only inspect files Git would add. Ignored databases, credentials, logs, and
# other runtime state never enter the candidate snapshot.
while IFS= read -r -d '' file; do
  [[ -f "$file" ]] || continue
  size="$(wc -c < "$file")"
  if [[ "$size" -gt "$MAX_FILE_BYTES" ]]; then
    echo "ERROR: refusing autosave; '$file' is $size bytes (limit: $MAX_FILE_BYTES)" >&2
    exit 1
  fi
done < <(git ls-files --cached --others --exclude-standard -z)

npm run --silent check:secrets

# Use an alternate index so user staging is preserved byte-for-byte.
GIT_INDEX_FILE="$ALT_INDEX" git read-tree HEAD
git ls-files --cached --others --exclude-standard -z \
  | GIT_INDEX_FILE="$ALT_INDEX" git update-index --add --remove -z --stdin
SNAPSHOT_TREE="$(GIT_INDEX_FILE="$ALT_INDEX" git write-tree)"

set +e
REMOTE_LINE="$(git ls-remote --exit-code --heads "$REMOTE" "refs/heads/$BRANCH" 2>&1)"
REMOTE_STATUS=$?
set -e

if [[ $REMOTE_STATUS -eq 0 ]]; then
  PARENT="${REMOTE_LINE%%[[:space:]]*}"
  git fetch --quiet "$REMOTE" "$PARENT"
  PARENT_TREE="$(git rev-parse "$PARENT^{tree}")"
elif [[ $REMOTE_STATUS -eq 2 ]]; then
  PARENT="$(git rev-parse HEAD)"
  PARENT_TREE="$(git rev-parse "HEAD^{tree}")"
else
  echo "ERROR: unable to read $REMOTE/$BRANCH" >&2
  echo "$REMOTE_LINE" >&2
  exit 1
fi

if [[ "$SNAPSHOT_TREE" == "$PARENT_TREE" ]]; then
  if [[ $REMOTE_STATUS -eq 2 ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      echo "Dry run: would initialize $REMOTE/$BRANCH at $PARENT"
    else
      git push "$REMOTE" "$PARENT:refs/heads/$BRANCH"
      echo "Initialized $REMOTE/$BRANCH at $PARENT"
    fi
  else
    echo "No Git-eligible changes to autosave."
  fi
  exit 0
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run: snapshot differs from $REMOTE/$BRANCH; no commit or push created."
  exit 0
fi

AUTHOR_NAME="$(git config user.name || true)"
AUTHOR_EMAIL="$(git config user.email || true)"
if [[ -z "$AUTHOR_NAME" || -z "$AUTHOR_EMAIL" ]]; then
  echo "ERROR: configure git user.name and user.email before enabling autosave" >&2
  exit 1
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MESSAGE="autosave: Mac mini snapshot $TIMESTAMP"
SNAPSHOT_COMMIT="$(printf '%s\n' "$MESSAGE" | git commit-tree "$SNAPSHOT_TREE" -p "$PARENT")"

# The new commit is always based on the remote tip observed above. A concurrent
# update fails safely as a non-fast-forward push and is retried next interval.
git push "$REMOTE" "$SNAPSHOT_COMMIT:refs/heads/$BRANCH"
echo "Pushed $MESSAGE ($SNAPSHOT_COMMIT) to $REMOTE/$BRANCH"
