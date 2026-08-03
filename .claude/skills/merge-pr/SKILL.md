---
name: merge-pr
description: Merge a Pull Request, close related issues, and sync local branch. Use when a PR is approved and ready to merge.
---

# Merge Pull Request

The mechanics live in `scripts/merge-pr.sh` (relative to this skill's base directory). Run it in **one** Bash call — do not reimplement its steps manually.

## Instructions

### 1. Release-PR gate (judgment)

If the PR is `develop` → `main` (a release PR), **confirm with the user first** — merging it fires the full release pipeline (build, sign, publish). For release PRs prefer `/release` (its `publish` subcommand); this script tolerates them safely (regular merge, never deletes develop, skips issue closing) but the confirmation stays with you.

### 2. Run the script

```bash
bash <skill-base-dir>/scripts/merge-pr.sh [pr-number]
```

Without an argument it resolves the PR from the current branch. The script handles everything deterministic:

- squash-merge + delete branch for feature PRs; regular merge (no delete) for release PRs
- 502-race safety: on merge failure it polls the PR state before retrying (a 502 can complete server-side; blind retry duplicates the squash commit)
- parses `Closes/Fixes/Resolves #N` from the PR body. Since `develop` is the default branch, GitHub auto-closes them on merge, so most are already closed here: only a still-open issue gets a `Done in #PR` comment + `gh issue close` (which has no `--comment` here). The board Status is set to Done for **every** referenced issue that ends up closed, auto-closed ones included (best-effort — a warning on stderr means set it manually). All of them are listed in `issues_closed`
- already-merged PR → skips the merge, still closes issues and syncs (safe re-run)
- always ends on `develop`, pulled up to date, local + remote feature branch cleaned up

Summary keys printed: `pr`, `title`, `merged`, `release_pr`, `issues_closed`, `branch`, `synced`.

### 3. Report

```
## PR Merged

**PR**: #XX - <title>
**Merged into**: develop

**Issues closed:**
- #10 <title>

**Local branch synced**: develop is up to date
```

## Notes

- Conventions sourced from `.claude/rules/conventions.md` (single source of truth)
- If the script errors, relay stderr to the user — don't fall back to running the merge steps by hand without asking
