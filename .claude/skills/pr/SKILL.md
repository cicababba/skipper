---
name: pr
description: Create a Pull Request targeting develop. Handles single issue or batch of issues from the current branch. Use when code is complete, manually tested, and ready for review.
---

# Create Pull Request

## Prerequisites

- Code is complete, user has manually tested, all changes committed.
- **CRITICAL**: Feature PRs always target `develop` (the script enforces this). A PR into `main` is a **release** — that's `/release`, not this skill.

The mechanics live in `scripts/pr.sh` (relative to this skill's base directory). Run it in **one** Bash call — do not reimplement its steps manually.

## Instructions

### 1. Identify issues (judgment)

- Primary issue from the branch name (`feature/issue-10-...`).
- All issues being closed: check `git log develop..HEAD --oneline`, confirm with the user (single or multiple).

### 2. Write the PR body (judgment)

Write the body to a temp file:

```markdown
## Summary

Closes #10, closes #11

<Brief description of changes>

## Changes

- <List main changes>

## Test Plan

- [x] Manual testing by user
- [ ] Automated tests pass (`pnpm test`)
- [ ] Lint passes (`pnpm lint`)

---
Generated with Claude Code
```

Use `Closes #X` for each issue — GitHub will NOT auto-close them (PR merges into `develop`, not the default branch); `/merge-pr` closes them explicitly.

### 3. Compose the PR title (judgment)

Same convention as issues: `<scope>:<type>: <descriptive>` (see `.claude/rules/conventions.md`). Feature PRs are squash-merged, so the title becomes the commit message on `develop`. The script derives PR labels from this prefix.

### 4. Run the script

```bash
bash <skill-base-dir>/scripts/pr.sh --title "<scope>:<type>: <descriptive>" --body-file <f> [--full|--skip-preflight]
```

Preflight tiers (user flags map straight through):

| Flag | What runs | Notes |
|------|-----------|-------|
| *(no flag)* | `pnpm lint && pnpm test` | default gate |
| `--full` | `pnpm lint && pnpm test && pnpm build` | adds the turbo build (slow — web + desktop) |
| `--skip-preflight` | nothing | escape hatch — use sparingly |

The script: rejects develop/main as source branch, aborts on uncommitted changes, runs the gate (`failed_step=lint|test|build` on failure — show the output, do **not** auto-suggest `--skip-preflight`), pushes with `-u`, creates the PR with `--base develop`, applies labels.

Summary keys printed: `pr`, `pr_url`, `branch`, `base`, `labels`, `preflight`.

### 5. Output summary

```
## Pull Request Created

**PR**: https://github.com/cicababba/skipper/pull/XX

**Issues referenced (will be closed by /merge-pr):**
- #10 <title>

Ready to review and merge!
```

## Notes

- Conventions sourced from `.claude/rules/conventions.md` (single source of truth)
- No project board in this repo — an open PR *is* the "in review" state
