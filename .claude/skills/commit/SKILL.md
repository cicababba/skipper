---
name: commit
description: Create a standardized commit with conventional format and co-author. Use when the user wants to commit changes or when changes are ready to be committed.
---

# Create Standardized Commit

Conventions live in `.claude/rules/conventions.md` ("Commits") — this skill applies them.

## Instructions

1. **Check for staged changes**:
   ```bash
   git diff --cached --stat
   ```
   - If nothing staged, check unstaged changes and ask user what to stage

2. **Show changed files** to understand what's being committed:
   ```bash
   git status --short
   ```

3. **Determine commit type** based on changes:
   - `feat`: New feature
   - `fix`: Bug fix
   - `refactor`: Code refactoring (no feature/fix)
   - `test`: Adding/updating tests
   - `docs`: Documentation only
   - `chore`: Build, config, dependencies
   - `style`: Formatting, no code change

   And the **scope** (optional but preferred), matching the existing history:
   `desktop`, `web`, `core`, `cli`, `db`, `shared`, `sync`, `infra` — or a narrower
   one like `win`/`mac` when platform-specific. Omit the scope only for truly
   cross-cutting changes.

4. **Ask user for commit message** if not provided, or suggest one based on changes

5. **Create commit** with standard format:
   ```bash
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <short description>

   <optional body - what and why>

   Co-Authored-By: <current model> <noreply@anthropic.com>
   EOF
   )"
   ```

## Commit Message Guidelines

### Format
```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: <current model> <noreply@anthropic.com>
```

### Examples

```bash
# Feature
feat(cli): session summary is now agentic

# Fix
fix(win): find claude regardless of stale PATH

# Refactor
refactor(core): extract provider selection into llm/index

# Test
test(sync): add manifest merge unit tests

# Chore (no scope — cross-cutting)
chore: bump version to 1.16.3
```

### Rules

- **Type**: Always lowercase
- **Scope**: Optional, lowercase, in parentheses
- **Description**: Imperative mood ("add" not "added"), no period at end
- **Body**: Explain what and why (not how)
- **Co-author**: Always include the co-author line for the Claude model actually
  running (e.g. `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`) — never
  hardcode a model name from an example

## Notes

- If user provides a message, use it but ensure format is correct
- If multiple logical changes, suggest splitting into multiple commits
