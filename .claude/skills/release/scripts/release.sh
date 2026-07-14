#!/usr/bin/env bash
set -euo pipefail

# Release mechanics, split so the human go/no-go sits between destructive phases.
# Merging into main fires .github/workflows/release.yml (full build + publish) —
# `publish` must only run after explicit user confirmation.
#
# Usage:
#   release.sh status                                        # read-only
#   release.sh prepare <new-version> [--body-file <f>] [--model <name>]
#   release.sh publish <pr-number>                           # DESTRUCTIVE: publishes

err() { echo "ERROR: $*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage: release.sh status                                        # read-only
       release.sh prepare <new-version> [--body-file <f>] [--model <name>]
       release.sh publish <pr-number>                           # DESTRUCTIVE: publishes
EOF
  exit 1
}

cd "$(git rev-parse --show-toplevel)"

pr_state() { gh pr view "$1" --json state --jq '.state'; }

wait_merged() {
  local pr="$1" i
  for i in {1..6}; do
    sleep 5
    [[ "$(pr_state "$pr")" == "MERGED" ]] && return 0
  done
  return 1
}

CMD="${1:-}"
shift || true

case "$CMD" in

status)
  git fetch origin main develop --quiet
  echo "version=$(node -p "require('./package.json').version")"
  echo "desktop_version=$(node -p "require('./apps/desktop/package.json').version")"
  EXISTING=$(gh pr list --base main --head develop --json number --jq '.[0].number // empty')
  echo "release_pr=${EXISTING:-none}"
  echo "changes_since_release:"
  git log origin/main..origin/develop --oneline --no-merges
  ;;

prepare)
  NEW="${1:-}"
  shift || true
  [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || err "version must be X.Y.Z (got '${NEW:-}')"
  BODY_FILE=""
  MODEL="Claude"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --body-file) BODY_FILE="$2"; shift 2 ;;
      --model) MODEL="$2"; shift 2 ;;
      *) err "unknown argument: $1" ;;
    esac
  done

  git checkout develop
  git pull origin develop
  [[ -z "$(git status --porcelain)" ]] || err "working tree not clean — commit or stash first"

  CURRENT=$(node -p "require('./package.json').version")
  if [[ "$CURRENT" == "$NEW" ]]; then
    echo "note=version already $NEW, skipping bump"
  else
    for f in package.json apps/desktop/package.json; do
      node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$f', 'utf8'));
        pkg.version = '$NEW';
        fs.writeFileSync('$f', JSON.stringify(pkg, null, 2) + '\n');
      "
    done
    git add package.json apps/desktop/package.json
    git commit -m "chore: bump version to $NEW

Co-Authored-By: $MODEL <noreply@anthropic.com>"
    git push origin develop
  fi

  EXISTING=$(gh pr list --base main --head develop --json number --jq '.[0].number // empty')
  if [[ -n "$EXISTING" ]]; then
    echo "pr=$EXISTING"
    echo "note=release PR already open, reusing it"
  else
    if [[ -z "$BODY_FILE" ]]; then
      BODY_FILE=$(mktemp)
      {
        echo "## Release v$NEW"
        echo
        echo "### Changes since last release"
        echo
        git log origin/main..develop --oneline --no-merges | sed 's/^/- /'
        echo
        echo "---"
        echo "Generated with Claude Code"
      } > "$BODY_FILE"
    fi
    URL=$(gh pr create --base main --head develop --title "Release v$NEW" --body-file "$BODY_FILE")
    echo "pr_url=$URL"
  fi
  echo "version=$NEW"
  echo "next=after user confirmation run: release.sh publish <pr-number> (fires the release pipeline)"
  ;;

publish)
  PR="${1:-}"
  [[ -n "$PR" ]] || usage
  IFS=$'\t' read -r STATE BASE HEAD_BRANCH TITLE < <(
    gh pr view "$PR" --json state,baseRefName,headRefName,title \
      --jq '[.state,.baseRefName,.headRefName,.title] | @tsv'
  )
  [[ "$BASE" == "main" && "$HEAD_BRANCH" == "develop" ]] || err "PR #$PR is $HEAD_BRANCH -> $BASE, not develop -> main"
  [[ "$TITLE" == Release\ v* ]] || err "PR #$PR title is not 'Release v...': $TITLE"

  MERGED="already"
  if [[ "$STATE" == "OPEN" ]]; then
    # regular merge, NEVER --delete-branch (develop must survive)
    if gh pr merge "$PR" --merge; then
      MERGED="true"
    else
      echo "merge command failed — polling PR state before retrying (502 can complete server-side)" >&2
      if wait_merged "$PR"; then
        MERGED="true (completed server-side despite error)"
      else
        gh pr merge "$PR" --merge
        MERGED="true"
      fi
    fi
  elif [[ "$STATE" != "MERGED" ]]; then
    err "PR #$PR is $STATE — nothing to publish"
  fi

  git checkout main
  git pull origin main
  git checkout develop
  git pull origin develop
  git merge main
  git push origin develop

  echo "pr=$PR"
  echo "merged=$MERGED"
  echo "branch=develop"
  echo "develop_synced_with_main=true"
  echo "pipeline=running — watch with: gh run list --workflow=release.yml"
  ;;

*)
  usage
  ;;
esac
