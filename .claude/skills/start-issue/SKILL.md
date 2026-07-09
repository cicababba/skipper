---
name: start-issue
description: Start working on GitHub issues. Can handle single issue or batch of related issues. Creates a feature branch from develop.
---

# Start Working on Issues

## Instructions

### 1. Get issue(s) from user

Can be:
- Single issue: `#10` or `10`
- Multiple issues: `#10, #11, #12` or `10 11 12`
- Batch reference: `batch #10-#14`

### 2. Fetch issue details for ALL issues

```bash
# For each issue number
gh issue view <number> --json number,title,labels,body --jq '{number, title, labels: [.labels[].name], body}'
```

### 3. Update issues with conversation details

**IMPORTANT**: Before proceeding, check if any details emerged during the conversation that should be added to the issues.

For each issue, ask yourself:
- Were implementation decisions made? (e.g., which library to use, API design)
- Were requirements clarified? (e.g., specific behavior, edge cases)
- Were technical choices discussed? (e.g., data model, IPC surface)

If yes, update the issue body with the new details:

```bash
gh issue edit <number> --body "$(cat <<'EOF'
<original body>

## Implementation Details (from discussion)

- <detail 1>
- <detail 2>
EOF
)"
```

Ask the user: "Do you want to add any details to the issues before starting?"

### 4. Create feature branch

From the **first/main issue** in the batch:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/issue-<first-number>-<slugified-description>
```

Branch naming:
- Single issue: `feature/issue-10-diff-view`
- Batch: `feature/issue-10-orchestrator-setup` (use descriptive name for the batch)

### 5. Output summary

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
- Always start from `develop` branch — never from `main`
- If branch already exists, ask user if they want to continue on it
- No project board in this repo — an existing feature branch *is* the "in progress" state
