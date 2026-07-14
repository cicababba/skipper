#!/usr/bin/env bash
set -euo pipefail

# Create a feature PR into develop: preflight gate, push, gh pr create, labels
# derived from the scope:type: title prefix.
#
# Usage: pr.sh --title "<scope>:<type>: <descriptive>" --body-file <f> [--full|--skip-preflight]
#   default preflight: pnpm lint && pnpm test
#   --full:            adds pnpm build
#   --skip-preflight:  skips everything (escape hatch)

err() { echo "ERROR: $*" >&2; exit 1; }

derive_labels() {
  local title="$1" prefix scopes type type_label labels
  prefix=$(grep -oE '^[a-z]+(,[a-z]+)*:(feat|fix|refactor|test|docs|chore):' <<<"$title" || true)
  [[ -n "$prefix" ]] || { echo ""; return; }
  scopes="${prefix%%:*}"
  type=$(cut -d: -f2 <<<"$prefix")
  case "$type" in
    feat) type_label="enhancement" ;;
    fix) type_label="bug" ;;
    refactor) type_label="refactor" ;;
    test) type_label="testing" ;;
    docs) type_label="documentation" ;;
    *) type_label="" ;;
  esac
  labels="$scopes"
  [[ -n "$type_label" ]] && labels="$labels,$type_label"
  echo "$labels"
}

TITLE=""
BODY_FILE=""
TIER="default"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) TITLE="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --full) TIER="full"; shift ;;
    --skip-preflight) TIER="skip"; shift ;;
    *) err "unknown argument: $1" ;;
  esac
done
[[ -n "$TITLE" && -n "$BODY_FILE" ]] || err "usage: pr.sh --title <t> --body-file <f> [--full|--skip-preflight]"
[[ -f "$BODY_FILE" ]] || err "body file not found: $BODY_FILE"

cd "$(git rev-parse --show-toplevel)"

BRANCH=$(git branch --show-current)
[[ -n "$BRANCH" ]] || err "detached HEAD"
[[ "$BRANCH" != "develop" && "$BRANCH" != "main" ]] || err "on '$BRANCH' — feature PRs come from feature branches (a PR into main is /release)"

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >&2
  err "uncommitted changes — commit or stash first"
fi

run_step() {
  local name="$1"
  shift
  if ! "$@"; then
    echo "failed_step=$name"
    exit 1
  fi
}

case "$TIER" in
  skip)
    echo "preflight=skipped" ;;
  full)
    run_step lint pnpm lint
    run_step test pnpm test
    run_step build pnpm build
    echo "preflight=lint,test,build" ;;
  *)
    run_step lint pnpm lint
    run_step test pnpm test
    echo "preflight=lint,test" ;;
esac

git push -u origin "$BRANCH"

URL=$(gh pr create --base develop --title "$TITLE" --body-file "$BODY_FILE")
PR_NUMBER="${URL##*/}"

# REST, not `gh pr edit --add-label`: the latter queries deprecated Projects
# classic via GraphQL and fails on this repo
LABELS=$(derive_labels "$TITLE")
if [[ -n "$LABELS" ]]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
  printf '{"labels":[%s]}' "$(sed 's/[^,]*/"&"/g' <<<"$LABELS")" \
    | gh api "repos/$REPO/issues/$PR_NUMBER/labels" --input - --silent \
    || echo "note=could not apply labels '$LABELS'" >&2
fi

echo "pr=$PR_NUMBER"
echo "pr_url=$URL"
echo "branch=$BRANCH"
echo "base=develop"
echo "labels=${LABELS:-none}"
