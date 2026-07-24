#!/usr/bin/env bash
set -euo pipefail

# Merge a PR, close its referenced issues, and end on an up-to-date develop.
# Handles the known quirks:
#   - `gh pr merge --delete-branch` leaves the local checkout on main, not develop
#   - `gh issue close` has no --comment flag in this environment
#   - a 502 from `gh pr merge` can still complete server-side (retrying blindly
#     duplicates the squash commit) — poll the PR state before retrying
#
# Usage: merge-pr.sh [pr-number]
#   Without an argument, resolves the PR from the current branch.

err() { echo "ERROR: $*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  BRANCH=$(git branch --show-current)
  [[ -n "$BRANCH" ]] || err "detached HEAD and no PR number given"
  PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number // empty')
  [[ -n "$PR_NUMBER" ]] || err "no open PR found for branch '$BRANCH' — pass a PR number"
fi

IFS=$'\t' read -r STATE BASE HEAD_BRANCH < <(
  gh pr view "$PR_NUMBER" --json state,baseRefName,headRefName \
    --jq '[.state,.baseRefName,.headRefName] | @tsv'
)
TITLE=$(gh pr view "$PR_NUMBER" --json title --jq '.title')
BODY=$(gh pr view "$PR_NUMBER" --json body --jq '.body')

pr_state() { gh pr view "$PR_NUMBER" --json state --jq '.state'; }

wait_merged() {
  local i
  for i in {1..6}; do
    sleep 5
    [[ "$(pr_state)" == "MERGED" ]] && return 0
  done
  return 1
}

IS_RELEASE=false
if [[ "$HEAD_BRANCH" == "develop" || "$HEAD_BRANCH" == "main" ]]; then
  IS_RELEASE=true
fi

MERGED="already"
if [[ "$STATE" == "OPEN" ]]; then
  if $IS_RELEASE; then
    MERGE_ARGS=(--merge)          # release PR: regular merge, NEVER delete develop
  else
    MERGE_ARGS=(--squash --delete-branch)
  fi
  if gh pr merge "$PR_NUMBER" "${MERGE_ARGS[@]}"; then
    MERGED="true"
  else
    echo "merge command failed — polling PR state before retrying (502 can complete server-side)" >&2
    if wait_merged; then
      MERGED="true (completed server-side despite error)"
    else
      echo "PR still open — retrying merge once" >&2
      if gh pr merge "$PR_NUMBER" "${MERGE_ARGS[@]}"; then
        MERGED="true"
      else
        wait_merged || err "merge failed twice and PR #$PR_NUMBER is still not merged"
        MERGED="true (completed server-side despite error)"
      fi
    fi
  fi
elif [[ "$STATE" != "MERGED" ]]; then
  err "PR #$PR_NUMBER is $STATE — nothing to do"
fi

ISSUES_CLOSED=()
if ! $IS_RELEASE; then
  ISSUE_NUMBERS=$(grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+' <<<"$BODY" \
    | grep -oE '[0-9]+' | sort -un || true)
  for n in $ISSUE_NUMBERS; do
    if [[ "$(gh issue view "$n" --json state --jq '.state')" == "OPEN" ]]; then
      gh issue comment "$n" --body "Done in #$PR_NUMBER"
      gh issue close "$n"
      ISSUES_CLOSED+=("$n")
      bash ".claude/scripts/board.sh" status "$n" Done >/dev/null 2>&1 \
        || echo "warning: board sync failed for #$n — set Done manually" >&2
    fi
  done
fi

git checkout develop
git pull origin develop

if ! $IS_RELEASE; then
  git branch -D "$HEAD_BRANCH" 2>/dev/null || true
  git push origin --delete "$HEAD_BRANCH" 2>/dev/null || true
fi

echo "pr=$PR_NUMBER"
echo "title=$TITLE"
echo "merged=$MERGED"
echo "release_pr=$IS_RELEASE"
echo "issues_closed=${ISSUES_CLOSED[*]:-none}"
echo "branch=develop"
echo "synced=true"
