---
name: commit
description: Create a standardized commit with conventional format and co-author. Use when the user wants to commit changes or when changes are ready to be committed.
---

# Create Standardized Commit

Conventions live in `.claude/rules/conventions.md` ("Commits") — this skill applies them. The mechanics live in `scripts/commit.sh` (relative to this skill's base directory).

## Instructions

### 1. Inspect what's staged

```bash
bash <skill-base-dir>/scripts/commit.sh suggest
```

Prints the staged stat plus scope candidates inferred from the changed paths. If nothing is staged it errors and shows `git status --short` — ask the user what to stage.

### 2. Compose the message (judgment)

Determine **type** (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`) and **scope** (optional but preferred: `desktop`, `web`, `core`, `cli`, `shared`, `sync`, `infra`, or narrower like `win`/`mac`; omit only for truly cross-cutting changes). If the user provided a message, use it but ensure the format is correct. If multiple logical changes are staged, suggest splitting into multiple commits.

Write the message to a temp file:

```
<type>(<scope>): <description>

[optional body — what and why]
```

- Description: imperative mood ("add" not "added"), no trailing period.
- Examples from history: `feat(cli): session summary is now agentic`, `fix(win): find claude regardless of stale PATH`, `chore: bump version to 1.16.3`.
- No need to add the co-author line yourself — the script appends it.

### 3. Run the script

```bash
bash <skill-base-dir>/scripts/commit.sh --message-file <f> --model "<current Claude model>"
```

The script verifies staged changes, validates the subject format, appends `Co-Authored-By: <model> <noreply@anthropic.com>` if missing, and commits.

Summary keys printed: `commit` (short sha), `subject`.

## Notes

- Pass the model actually running via `--model` (e.g. `Claude Fable 5`) — never hardcode a model name from an example
