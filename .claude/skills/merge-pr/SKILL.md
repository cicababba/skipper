---
name: merge-pr
description: Merge a Pull Request, close related issues, and sync local branch. Use when a PR is approved and ready to merge.
---

# Merge Pull Request

## Instructions

### 1. Determine PR number

**If PR number provided as argument:**
```bash
PR_NUMBER=<argument>
```

**If no argument, get from current branch:**
```bash
BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number')
```

If no PR found, inform user and exit.

### 2. Get PR details

```bash
gh pr view $PR_NUMBER --json number,title,baseRefName,headRefName,body,state
```

- Verify PR is open (state = "OPEN")
- Extract base branch (usually `develop`)
- Extract issue numbers from body (look for `Closes #X`, `closes #X`, `Fixes #X`, etc.)

### 3. Extract related issues

Parse the PR body to find all issue references:
```bash
gh pr view $PR_NUMBER --json body --jq '.body' | grep -oiE '(closes|fixes|resolves) #[0-9]+' | grep -oE '[0-9]+'
```

### 4. Merge the PR

**IMPORTANT**: Only use `--delete-branch` for feature branches, NEVER for `develop`!

```bash
BASE_BRANCH=$(gh pr view $PR_NUMBER --json baseRefName --jq '.baseRefName')
HEAD_BRANCH=$(gh pr view $PR_NUMBER --json headRefName --jq '.headRefName')

if [ "$HEAD_BRANCH" = "develop" ]; then
  # Release PR: develop → main — DO NOT delete develop!
  # NOTE: merging into main triggers the full release pipeline
  # (mac+win build, Polar upload, update feed). Confirm with the user first.
  gh pr merge $PR_NUMBER --merge
else
  # Feature PR: feature/* → develop - safe to delete
  gh pr merge $PR_NUMBER --squash --delete-branch
fi
```

### 5. Close ALL related issues

Feature PRs merge into `develop` (not the default branch), so GitHub does **not** auto-close the referenced issues. Close them explicitly:

```bash
for issue_num in <list-of-issues>; do
  gh issue close $issue_num --comment "Done in #$PR_NUMBER"
  echo "Issue #$issue_num → closed"
done
```

(Skip this for release PRs — their issues were already closed when the feature PRs merged.)

### 6. Checkout base branch and pull

```bash
BASE_BRANCH=<from-step-2>
git checkout $BASE_BRANCH
git pull origin $BASE_BRANCH
```

### 7. Output summary

```
## PR Merged

**PR**: #XX - <title>
**Merged into**: develop

**Issues closed:**
- #10 <title>
- #11 <title>

**Local branch synced**: develop is up to date
```

## Notes

- Conventions sourced from `.claude/rules/conventions.md` (single source of truth)
- Feature branches: squash merge + delete branch
- Release PRs (develop → main): regular merge, **NEVER delete develop**, and they fire the release build — always confirm with the user before merging one
- If local branch was the PR branch, you'll be on base branch after
