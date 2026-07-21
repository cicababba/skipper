---
name: create-issue
description: Create a new GitHub issue with proper title convention and labels. Use when the user wants to open an issue for a bug, feature, or task.
---

# Create GitHub Issue

Title convention: `<scope>:<type>: <descriptive title>` — full spec in `.claude/rules/conventions.md` ("Issue & PR Titles"). The mechanics (label derivation + creation) live in `scripts/create-issue.sh` (relative to this skill's base directory).

## Instructions

### 1. Gather inputs

Ask the user for the **free-form description** (what + why). The user does not type the title prefix — you derive it.

### 2. Infer scope + type (judgment)

**Scope** (one or more, comma-separated for cross-cutting work): `desktop`, `web`, `core`, `cli`, `shared`, `sync`, `infra`, `epic`.

Signals:
- Electron, main process, preload, IPC, PTY, packaging, installer, auth flow → `desktop`
- UI, component, editor, CodeMirror, xterm, file tree, Next.js, React, Tailwind → `web`
- LLM provider, vectorstore, embeddings, knowledge atoms → `core`
- `skipper` command, commander, CLI flags/output → `cli`
- shared types, constants → `shared`
- SyncBackend, manifest → `sync`
- CI/CD, GitHub Actions, build scripts, repo tooling → `infra`
- umbrella issue meant to be broken into sub-issues → `epic` (a scope, never a type; typically `epic:feat: ...`)

If work genuinely spans 2+ scopes and splitting feels artificial → comma-list (`core,shared`). Default to splitting when feasible.

**Type** (single): `feat` (add/implement/new), `fix` (bug/broken/regression), `refactor` (extract/rewrite/cleanup), `test`, `docs`, `chore` (bump/upgrade/trivial maintenance).

**If you cannot confidently infer scope or type → STOP and ask the user.**

### 3. Confirm title with user

```
Proposed title: <scope>:<type>: <descriptive>
Body:           <one-line summary of what you'll write>
```

Wait for confirmation or edits.

### 4. Write the body (judgment) and run the script

Write the issue body to a temp file, then:

```bash
bash <skill-base-dir>/scripts/create-issue.sh --title "<scope>:<type>: <descriptive>" --body-file <f>
```

The script validates the title format and scopes, derives labels (scope names as-is; type per conventions: feat→enhancement, fix→bug, refactor→refactor, test→testing, docs→documentation, chore→none), and creates the issue.

Summary keys printed: `issue`, `url`, `labels`, `board`.

### 5. Output summary

```
## Issue Created

**Issue**: #XX <full title>
**Scope/Type**: <scope>:<type>
**Labels**: <labels>

<issue URL>
```

## Notes

- Conventions sourced from `.claude/rules/conventions.md` (single source of truth)
- The script also adds the issue to the project board with Status=Backlog (best-effort;
  a `board=sync failed` line means add it manually) — board contract in conventions.md
- The convention applies to **new** issues only — existing issues stay as-is
