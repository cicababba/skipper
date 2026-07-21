#!/usr/bin/env bash
set -euo pipefail

# Create a GitHub issue with labels derived from the scope:type: title prefix.
#
# Usage: create-issue.sh --title "<scope>:<type>: <descriptive>" --body-file <f>

err() { echo "ERROR: $*" >&2; exit 1; }

KNOWN_SCOPES="desktop web core cli db shared sync infra epic"

TITLE=""
BODY_FILE=""
STATUS="Backlog"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) TITLE="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    *) err "unknown argument: $1" ;;
  esac
done
[[ -n "$TITLE" && -n "$BODY_FILE" ]] || err "usage: create-issue.sh --title <t> --body-file <f> [--status <Backlog|Todo|In Progress|Done>]"
case "$STATUS" in Backlog|Todo|"In Progress"|Done) ;; *) err "invalid --status '$STATUS' (Backlog|Todo|In Progress|Done)" ;; esac
[[ -f "$BODY_FILE" ]] || err "body file not found: $BODY_FILE"

TITLE_RE='^[a-z]+(,[a-z]+)*:(feat|fix|refactor|test|docs|chore): .+'
[[ "$TITLE" =~ $TITLE_RE ]] || err "title must be '<scope>:<type>: <descriptive>' (see .claude/rules/conventions.md): $TITLE"

SCOPES="${TITLE%%:*}"
TYPE=$(cut -d: -f2 <<<"$TITLE")

for s in ${SCOPES//,/ }; do
  grep -qw "$s" <<<"$KNOWN_SCOPES" || err "unknown scope '$s' (known: $KNOWN_SCOPES)"
done

case "$TYPE" in
  feat) TYPE_LABEL="enhancement" ;;
  fix) TYPE_LABEL="bug" ;;
  refactor) TYPE_LABEL="refactor" ;;
  test) TYPE_LABEL="testing" ;;
  docs) TYPE_LABEL="documentation" ;;
  *) TYPE_LABEL="" ;;
esac

LABELS="$SCOPES"
[[ -n "$TYPE_LABEL" ]] && LABELS="$LABELS,$TYPE_LABEL"

URL=$(gh issue create --title "$TITLE" --body-file "$BODY_FILE" --label "$LABELS")
NUMBER="${URL##*/}"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
BOARD="added ($STATUS)"
if [[ -z "$ROOT" ]] || ! bash "$ROOT/.claude/scripts/board.sh" status "$NUMBER" "$STATUS" >/dev/null 2>&1; then
  BOARD="sync failed (add manually)"
fi

echo "issue=$NUMBER"
echo "url=$URL"
echo "labels=$LABELS"
echo "board=$BOARD"
