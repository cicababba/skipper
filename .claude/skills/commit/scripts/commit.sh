#!/usr/bin/env bash
set -euo pipefail

# Create a conventional commit from a message file, enforcing format and the
# co-author line.
#
# Usage:
#   commit.sh --message-file <f> [--model "<current Claude model>"]
#   commit.sh suggest            # staged stat + scope candidates from changed paths

err() { echo "ERROR: $*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "suggest" ]]; then
  [[ -n "$(git diff --cached --name-only)" ]] || { git status --short; err "nothing staged"; }
  git diff --cached --stat
  echo "scope_candidates:"
  git diff --cached --name-only | awk -F/ '
    $1 == "apps" && NF > 1 { print $2; next }
    $1 == "packages" && NF > 1 { print $2; next }
    $1 == ".github" || $1 == "scripts" || $1 == ".claude" { print "infra"; next }
    { print "(root)" }' | sort | uniq -c | sort -rn
  exit 0
fi

MSG_FILE=""
MODEL="Claude"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --message-file) MSG_FILE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) err "unknown argument: $1" ;;
  esac
done
[[ -n "$MSG_FILE" ]] || err "usage: commit.sh --message-file <f> [--model <name>] | commit.sh suggest"
[[ -f "$MSG_FILE" ]] || err "message file not found: $MSG_FILE"

if [[ -z "$(git diff --cached --name-only)" ]]; then
  git status --short >&2
  err "nothing staged — stage changes first"
fi

SUBJECT=$(head -n1 "$MSG_FILE")
SUBJECT_RE='^(feat|fix|refactor|test|docs|chore|style)(\([a-z0-9,/-]+\))?: .+'
[[ "$SUBJECT" =~ $SUBJECT_RE ]] || err "subject does not match '<type>(<scope>): <description>': $SUBJECT"
[[ "$SUBJECT" != *. ]] || err "subject must not end with a period: $SUBJECT"

TMP=$(mktemp)
cat "$MSG_FILE" > "$TMP"
if ! grep -q '^Co-Authored-By:' "$TMP"; then
  printf '\nCo-Authored-By: %s <noreply@anthropic.com>\n' "$MODEL" >> "$TMP"
fi

git commit -F "$TMP"
rm -f "$TMP"

echo "commit=$(git rev-parse --short HEAD)"
echo "subject=$SUBJECT"
