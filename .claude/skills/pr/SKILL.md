---
name: pr
description: Create a Pull Request targeting develop. Handles single issue or batch of issues from the current branch. Use when code is complete, manually tested, and ready for review.
---

# Create Pull Request

## Prerequisites

Before using this skill, ensure:
- Code is complete
- User has manually tested and confirmed it works
- All changes are committed

**CRITICAL**: Always use `--base develop` when creating feature PRs. The repo's default branch is `main` but we use gitflow with `develop` as the integration branch. A PR into `main` is a **release** — that's `/release`, not this skill (merging to `main` triggers the full build + publish pipeline).

## Instructions

### 1. Check current branch and identify issues

```bash
BRANCH=$(git branch --show-current)
# Extract primary issue number from branch name (feature/issue-10-...)
PRIMARY_ISSUE=$(echo $BRANCH | grep -oP 'issue-\K\d+')
```

### 2. Get list of ALL issues being closed

Look at:
- Commits in the branch: `git log develop..HEAD --oneline`
- Ask user to confirm which issues this PR closes
- Could be single (`#10`) or multiple (`#10, #11, #12`)

### 3. Check for uncommitted changes

```bash
git status --porcelain
```
- If changes exist, ask user if they want to commit first

### 4. Run pre-flight checks

The default gate is lint + tests. Flags adjust the tier:

| Flag | What runs | Notes |
|------|-----------|-------|
| *(no flag)* | `pnpm lint && pnpm test` | default gate |
| `--full` | `pnpm lint && pnpm test && pnpm build` | adds the turbo build (slow — web + desktop) |
| `--skip-preflight` | nothing | escape hatch — use sparingly |

```bash
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

case "${PR_FLAG:-}" in
  --skip-preflight)
    echo "[pr] --skip-preflight set; skipping all checks." ;;
  --full)
    pnpm lint && pnpm test && pnpm build ;;
  *)
    pnpm lint && pnpm test ;;
esac
```

**On failure**, show which step failed (`lint`, `test`, or `build`) and the relevant output. Do not auto-suggest `--skip-preflight` — that's the escape hatch, not a normal recovery path.

Only proceed to push after the gate passes (or the user explicitly skipped it).

### 5. Push branch to remote

```bash
git push -u origin $BRANCH
```

### 6. Get issue details for PR

```bash
gh issue view $PRIMARY_ISSUE --json title,labels
```

### 7. Create PR with ALL issues referenced

PR title follows the same convention as issues: `<scope>:<type>: <descriptive>` (see `.claude/rules/conventions.md`). Feature PRs are squash-merged, so the PR title becomes the commit message on `develop`.

```bash
gh pr create \
  --base develop \
  --title "<scope>:<type>: <descriptive title>" \
  --body "$(cat <<'EOF'
## Summary

Closes #10, closes #11, closes #12

<Brief description of changes>

## Changes

- <List main changes>

## Test Plan

- [x] Manual testing by user
- [ ] Automated tests pass (`pnpm test`)
- [ ] Lint passes (`pnpm lint`)

---
Generated with Claude Code
EOF
)"
```

### 8. Output summary

```
## Pull Request Created

**PR**: https://github.com/cicababba/skipper/pull/XX

**Issues referenced (will be closed by /merge-pr):**
- #10 <title>
- #11 <title>

Ready to review and merge!
```

## Notes

- Conventions sourced from `.claude/rules/conventions.md` (single source of truth)
- Always target `develop` branch (gitflow) — `main` is release-only
- Use `Closes #X` for each issue. **GitHub will NOT auto-close them** (the PR merges into `develop`, not the default branch) — `/merge-pr` closes them explicitly
- No project board in this repo — an open PR *is* the "in review" state
