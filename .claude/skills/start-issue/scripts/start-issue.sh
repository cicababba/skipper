#!/usr/bin/env bash
set -euo pipefail

# Start work on one or more issues: fetch details, sync develop, create (or
# reuse) the feature branch.
#
# Usage: start-issue.sh [--slug <slug>] <issue> [issue...]
#   Issue numbers may carry a leading '#'. Without --slug, the branch slug is
#   derived from the first issue's title (scope:type: prefix stripped).

err() { echo "ERROR: $*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

SLUG=""
if [[ "${1:-}" == "--slug" ]]; then
  [[ $# -ge 2 ]] || err "--slug needs a value"
  SLUG="$2"
  shift 2
fi
[[ $# -ge 1 ]] || err "usage: start-issue.sh [--slug <slug>] <issue> [issue...]"

ISSUES=()
for a in "$@"; do
  n="${a#\#}"
  [[ "$n" =~ ^[0-9]+$ ]] || err "not an issue number: $a"
  ISSUES+=("$n")
done

for n in "${ISSUES[@]}"; do
  gh issue view "$n" --json number,title,labels \
    --jq '{number, title, labels: [.labels[].name]} | "issue=\(tojson)"'
done

FIRST="${ISSUES[0]}"
if [[ -z "$SLUG" ]]; then
  FIRST_TITLE=$(gh issue view "$FIRST" --json title --jq '.title')
  SLUG=$(sed -E 's/^[a-z]+(,[a-z]+)*:[a-z]+:[[:space:]]*//' <<<"$FIRST_TITLE" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
  if (( ${#SLUG} > 40 )); then
    SLUG="${SLUG:0:40}"
    SLUG="${SLUG%-*}"   # drop the truncated partial word
  fi
  [[ -n "$SLUG" ]] || err "could not derive a slug from issue #$FIRST title — pass --slug"
fi

BRANCH="feature/issue-${FIRST}-${SLUG}"

git checkout develop
git pull origin develop

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
  REUSED=true
else
  git checkout -b "$BRANCH"
  REUSED=false
fi

echo "branch=$BRANCH"
echo "reused=$REUSED"
