# Conventions

Single source of truth for git/GitHub conventions in this repo. The skills in
`.claude/skills/` reference this file — update here, not in the skills.

## Branching (gitflow)

- **`main`** — release branch. Every push to `main` triggers `.github/workflows/release.yml`:
  full mac+win signed build, upload to Polar, auto-update feed, private releases repo.
  **Never push work directly to `main`.**
- **`develop`** — integration branch. All feature PRs target `develop`.
- **`feature/issue-<N>-<slug>`** — feature branches, cut from `develop`.
  Batch branches use the first issue number: `feature/issue-10-oauth-refactor`.
- **Releases** — PR `develop` → `main`, regular merge (no squash), **never delete `develop`**.
  After the merge, merge `main` back into `develop` so the branches stay aligned.

## Issue & PR titles

Format: `<scope>:<type>: <descriptive title>`

- **Scope** (one or more, comma-separated for cross-cutting work):

  | Scope | Area |
  |-------|------|
  | `desktop` | `apps/desktop` — Electron shell, main/preload, IPC, packaging hooks |
  | `web` | `apps/web` — Next.js UI, components, editor, terminal UI |
  | `core` | `packages/core` — compiler, ingest, llm, qa, search, lint, vectorstore |
  | `cli` | `packages/cli` — the `nestbrain` CLI |
  | `db` | `packages/db` — Chroma client + embeddings wrapper |
  | `shared` | `packages/shared` — shared types and constants |
  | `sync` | `packages/sync` — Drive sync engine |
  | `infra` | CI/CD, workflows, build scripts, docker, repo tooling |
  | `epic` | Umbrella issue meant to be broken into sub-issues |

- **Type** (single value): `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- `epic` is a **scope**, never a type. An umbrella issue is typically `epic:feat: ...`.
- The descriptive title is plain prose, free-form, no leading capital required.

Examples: `web:feat: diff view for worktree changes`, `desktop:fix: PTY resize race on Windows`,
`core,shared:refactor: extract provider types`, `epic:feat: issue orchestration loop`.

PR titles follow the same convention (feature PRs are squash-merged, so the PR title
becomes the commit message on `develop`). Release PRs are titled `Release v<X.Y.Z>`.

## Labels

Scope → label: same name as the scope (`desktop`, `web`, `core`, `cli`, `db`, `shared`, `sync`, `infra`, `epic`).

Type → label:

| Type | Label |
|------|-------|
| `feat` | `enhancement` |
| `fix` | `bug` |
| `refactor` | `refactor` |
| `test` | `testing` |
| `docs` | `documentation` |
| `chore` | (none) |

Combine both sets, deduplicated. Example: `web:feat:` → `web,enhancement`.

## Commits

Conventional format with optional scope, matching the existing history
(`feat(cli): ...`, `fix(win): ...`):

```
<type>(<scope>): <description>

[optional body — what and why]

Co-Authored-By: <current Claude model> <noreply@anthropic.com>
```

- Type lowercase; scope optional but preferred (use the scopes above, or a narrower
  one like `win`/`mac` when platform-specific).
- Description in imperative mood ("add" not "added"), no trailing period.
- Co-author line uses the model actually running (e.g. `Claude Fable 5`).

## Issue lifecycle (no project board)

This repo uses **no project board**. State is derived from git/GitHub itself:

- Open issue, no branch → todo
- Feature branch exists → in progress
- PR open referencing the issue → in review
- Issue closed → done

PRs reference issues with `Closes #N` for traceability, but since feature PRs merge
into `develop` (not the default branch), GitHub does **not** auto-close them —
`/merge-pr` closes the referenced issues explicitly.
