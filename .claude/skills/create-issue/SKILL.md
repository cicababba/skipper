---
name: create-issue
description: Create a new GitHub issue with proper title convention and labels. Use when the user wants to open an issue for a bug, feature, or task.
---

# Create GitHub Issue

## Title convention

Every issue title follows: `<scope>:<type>: <descriptive title>`

The full convention is documented in `.claude/rules/conventions.md` ("Issue & PR Titles") — read it once if unfamiliar. Quick reference:

- **Scope** (one or more, comma-separated for cross-cutting work): `desktop`, `web`, `core`, `cli`, `db`, `shared`, `sync`, `infra`, `epic`
- **Type** (single value, conventional-commits style): `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- `epic` is a **scope**, never a type. An umbrella issue is typically `epic:feat: ...`.
- The `<descriptive title>` is plain prose, free-form, no leading capital required.

Examples: `web:feat: diff view for worktree changes`, `desktop:fix: PTY resize race on Windows`, `epic:feat: issue orchestration loop`, `core,shared:refactor: extract provider types`.

## Instructions

### 1. Gather inputs

Ask the user for the **free-form description** of the issue (what + why). The user does not type the title prefix — you derive it.

### 2. Infer scope + type

From the description, infer:

**Scope inference signals**:
- Mentions of `apps/desktop`, "Electron", "main process", "preload", "IPC", "tray", "PTY", "node-pty", "packaging", "installer", "auth flow", "keychain" → `desktop`
- Mentions of `apps/web`, "UI", "component", "editor", "CodeMirror", "xterm", "file tree", "Next.js", "React", "Tailwind" → `web`
- Mentions of `packages/core`, "LLM provider", "vectorstore", "embeddings", "knowledge atoms" → `core`
- Mentions of `packages/cli`, "nestbrain command", "commander", CLI flags/output → `cli`
- Mentions of `packages/shared`, shared types, constants, OAuth client constants → `shared`
- Mentions of `packages/sync`, "Drive sync", "watcher", "manifest", "chokidar" → `sync`
- Mentions of CI/CD, GitHub Actions, `release.yml`, build scripts, electron-builder config, repo tooling → `infra`
- An umbrella issue meant to be broken into per-package sub-issues → `epic`

If the work genuinely spans 2+ scopes and splitting feels artificial → comma-list, e.g. `core,shared`. Default to splitting when feasible.

**Type inference signals**:
- "fix", "bug", "broken", "regression" → `fix`
- "feature", "add", "implement", "build", "new" → `feat`
- "refactor", "extract", "rewrite", "cleanup", "split into service layer" → `refactor`
- "test", "coverage", "add tests for" → `test`
- "docs", "documentation", "README", "rule" → `docs`
- "bump", "upgrade", "rename only", trivial maintenance → `chore`

**If you cannot confidently infer scope or type → STOP and ask the user.** A wrong scope/type is worse than a one-line clarifying question.

### 3. Confirm title with user

Before creating, propose the constructed title and short body summary back to the user:

```
Proposed title: <scope>:<type>: <descriptive>
Body:           <one-line summary of what you'll write>
```

Wait for confirmation or edits. The user can override scope, type, or descriptive part.

### 4. Determine labels

Add labels based on the resolved scope(s) and type:

**Scope → label**: same name as the scope, applied for every scope in the list
(`desktop`, `web`, `core`, `cli`, `db`, `shared`, `sync`, `infra`, `epic`).

**Type → label** mapping:

| Type | Label |
|------|-------|
| `feat` | `enhancement` |
| `fix` | `bug` |
| `refactor` | `refactor` |
| `test` | `testing` |
| `docs` | `documentation` |
| `chore` | (none) |

Combine both sets (deduplicated). Example: `web:feat:` → labels `web,enhancement`. `core,shared:fix:` → labels `core,shared,bug`. `epic:feat:` → labels `epic,enhancement`.

### 5. Create the issue

```bash
gh issue create \
  --title "<scope>:<type>: <descriptive>" \
  --body "<body>" \
  --label "<comma-separated-labels>"
```

Capture the issue number from the output URL.

### 6. Output summary

```
## Issue Created

**Issue**: #XX <full title>
**Scope/Type**: <scope>:<type>
**Labels**: <labels>

<issue URL>
```

## Notes

- Conventions sourced from `.claude/rules/conventions.md` (single source of truth)
- No project board in this repo — issue state is derived from git/GitHub (see conventions)
- The convention applies to **new** issues only — existing issues stay as-is
