---
name: start-issue
description: Start working on GitHub issues. Can handle single issue or batch of related issues. Creates a feature branch from develop.
---

# Start Working on Issues

The mechanics live in `scripts/start-issue.sh` (relative to this skill's base directory). Run it in **one** Bash call — do not reimplement its steps manually.

## Instructions

### 1. Get issue(s) from user

Can be:
- Single issue: `#10` or `10`
- Multiple issues: `#10, #11, #12` or `10 11 12`
- Batch reference: `batch #10-#14`

### 2. Update issues with conversation details (judgment)

Before running the script, check if details emerged during the conversation that should be added to the issues (implementation decisions, clarified requirements, technical choices). If yes, append an `## Implementation Details (from discussion)` section via `gh issue edit <n> --body ...`, and ask the user: "Do you want to add any details to the issues before starting?"

Skip this entirely in a fresh session with no prior discussion.

### 3. Run the script

```bash
bash <skill-base-dir>/scripts/start-issue.sh [--slug <slug>] <issue> [issue...]
```

- Pass `--slug` when you want a descriptive batch name (e.g. `--slug oauth-refactor` for a batch) or when the auto-slug from the first issue's title would be poor. Otherwise the script slugifies the first issue's title itself.
- The script fetches each issue (prints one `issue={json}` line with number/title/labels), checks out `develop`, pulls, and creates `feature/issue-<first>-<slug>`.
- If the branch already exists it reuses it and reports `reused=true` — tell the user work continues on the existing branch.

Summary keys printed: `issue=` (one per issue), `branch`, `reused`.

### 4. Output summary

```
## Started Working

**Branch**: feature/issue-10-orchestrator-setup

**Issues in scope:**
- #10 <title>
- #11 <title>

Ready to code!

💡 **Tip**: Use `/plan-issue` to analyze the issue and create an implementation plan before coding.
```

## Notes

- Conventions sourced from `.claude/rules/conventions.md` (single source of truth)
- The script always starts from `develop` — never from `main`
- No project board in this repo — an existing feature branch *is* the "in progress" state
