# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

# Skipper

Skipper is a **cross-platform issue inbox + orchestration layer on top of coding agents**: assigned issues arrive with an eager plan and a verifiable confidence score, coding runs in isolated worktrees behind a human gate, and PRs are shepherded to merge. Issue sources/code hosts: GitHub, GitLab, Jira, OpenProject, and Bitbucket. On top of the loop: a repo-grounded chat composer that drafts issues (plus a no-agent quick path) with saved/auto-saved drafts, per-repo agent instructions, and a solutions-memory tab with semantic search and curation.

Naming is uniform: package scopes are `@skipper/*`, the IPC prefix is `skipper:*`, the CLI is `skipper`, env vars are `SKIPPER_*`, appId is `com.cicababba.skipper`.

## Repo Layout (pnpm monorepo)

```
skipper/
├── apps/
│   ├── desktop/                # Electron 33 shell (main + preload + builder config)
│   │   ├── src/main.ts         # Electron main: PATH fix, IPC, app://skipper static-export protocol
│   │   ├── src/git.ts          # Git backend (public core)
│   │   ├── src/terminal.ts     # PTY session manager (public core)
│   │   ├── src/auth/           # Multi-provider OAuth desktop flow (Google, GitHub, GitLab, Jira, OpenProject, Bitbucket; loopback)
│   │   ├── src/orchestrator.ts # Issue-orchestration loop (+ planner, coder, reviewer, shepherd,
│   │   │                       #   plan-store, worktrees, repo-links, inbox-cursor-store, updater,
│   │   │                       #   composer-chat + draft stores, repo-instructions + distiller,
│   │   │                       #   agent-chat, create-issue IPC, graphify: per-repo knowledge-graph index)
│   │   ├── src/preload.ts      # Renderer-safe IPC bridge
│   │   └── build/              # electron-builder hooks, icons, NSIS installer
│   └── web/                    # Next.js 16 + React 19 UI (static export, served over app://skipper inside Electron)
│       └── src/{app,components,lib,types}
├── packages/
│   ├── cli/                    # `skipper` CLI (commander): knowledge, projects, session, memory, guard
│   ├── core/                   # Domain logic
│   │   └── src/{llm,runtime,vectorstore,knowledge,orchestrator,planner,coder,reviewer,shepherd,
│   │            confidence,memory,adapters,composer,agent-chat,instructions}
│   ├── shared/                 # Types and constants (auth types live here so main + renderer share them)
│   └── sync/                   # Orchestrator seams: diffFiles + SyncBackend contract, local manifest
│       └── src/{backend,manifest,types}
├── data/                       # Local-dev scratch data (untouched by the build)
├── docs/screenshots/
├── pnpm-workspace.yaml
├── turbo.json
└── package.json                # version source of truth (kept aligned with apps/desktop/package.json)
```

## Tech Stack

- **Language**: TypeScript 5.9 (Node 20+, ESM where possible, CJS where Electron forces it)
- **Package manager**: pnpm 10 + Turborepo
- **Desktop shell**: Electron 33, `node-pty` (lazy-loaded), `electron-builder` (mac DMG signed/notarized, Windows NSIS, Linux placeholder)
- **UI**: Next.js 16.2 + React 19, CodeMirror 6, xterm.js + addon-fit, lucide-react, Tailwind v4
- **CLI**: `commander`
- **LLM completions providers** (`packages/core/src/llm/`): `claude-cli` (default — spawns the user's `claude` CLI) and `openai`. This is the completions backend the roles fall back to for structured/repair rounds — it must only ever see Claude model aliases (or the OpenAI model).
- **Agent runtimes** (`packages/core/src/runtime/`): the `AgentRuntime` seam with a capability matrix; adapters for `claude-cli`, `codex-cli`, `copilot-cli`, `gemini-cli`. Every orchestration role (planner, coder, reviewer, composer, …) is selected as a coupled `(runtime, model)` pair — per role globally and overridable per repo. The model menu is derived from the runtime, so a Claude alias can never be attached to another vendor's CLI; empty model means "the CLI's own configured default".
- **Embeddings**: `@huggingface/transformers` running ONNX locally (`Xenova/all-MiniLM-L6-v2`), in `packages/core/src/vectorstore`
- **Knowledge graph** (opt-in per repo): [Graphify](https://github.com/Graphify-Labs/graphify) — tree-sitter AST index of the linked repo, extracted code-only (no LLM, no API key) from a throwaway worktree at the base ref. Queried via the `graphify-mcp` stdio server (7 local graph tools allowlisted, wired into every runtime's MCP config) by the planner, the composer, and the plan/agent chats — the coder is excluded by construction. Python runtime isolated in `<userData>/tools` via a bundled `uv` binary — two pins to maintain: `UV_VERSION` in `apps/desktop/build/prepare-uv.mjs` and `GRAPHIFY_PIP_SPEC` in `apps/desktop/src/graphify-runtime.ts`
- **Repo instructions**: per-repo agent instructions in `<userData>/repo-instructions/`, seeded at link time from the checkout's `CLAUDE.md` → `AGENTS.md` → `.github/copilot-instructions.md` → `GEMINI.md` (first non-blank wins) or generated agentically when none exists; injected into the planner/coder/composer prompts. A ready doc is never re-seeded automatically — regeneration is explicit (`force`).
- **Auth**: multi-provider multi-account OAuth desktop flow (loopback redirect) behind a `ProviderConfig` registry in `apps/desktop/src/auth/` — registered providers: `google`, `github`, `gitlab`, `jira`, `openproject`, `bitbucket`. Google: PKCE, identity-only scopes — proves the email for the supporter update entitlement (`getIdToken`, Google-only path). GitHub: GitHub App user-to-server flow, fixed loopback ports 8127–8129, expiring tokens with refresh rotation — feeds the orchestrator. GitLab/Jira/OpenProject/Bitbucket feed the tracker/code-host adapters in `packages/core/src/adapters` (OpenProject also supports an API-key path: HTTP Basic, username `apikey`). Accounts + tokens live in one `auth.enc` (v2 multi-account format) encrypted via Electron `safeStorage`.
- **Testing**: Vitest (configured at root). Coverage is solid where it counts: `packages/core/tests/` (~72 files, incl. a 54-case reconcile suite and ~32 adapter suites covering the GitHub/GitLab/Jira/OpenProject/Bitbucket clients, mappers, polls and actions), every desktop driver loop (planner/coder/reviewer/shepherd/rescore/plan-chat/composer-chat/drafts via injected deps), the pure stores (worktrees, plan-store, repo-links, draft stores), and the pure modules in `apps/web/src/lib/{inbox,composer,agents,export}` (1:1 tests). Known holes: `apps/desktop/src/orchestrator.ts` wiring (zero tests), most of the Electron shell (`main.ts`, `auth/`). Test-writing and failure-triage rules live in [`.claude/rules/testing.md`](.claude/rules/testing.md).
- **Lint/format**: ESLint 9 + Prettier 3

## Key Commands

### Repo-level (pnpm + turbo)

```bash
pnpm install                       # bootstrap workspace
pnpm dev                           # turbo dev across all packages
pnpm build                         # turbo build
pnpm lint                          # turbo lint
pnpm test                          # turbo test (vitest)
pnpm format                        # prettier write
```

### Desktop app

```bash
pnpm desktop:dev                   # build TS + launch Electron with SKIPPER_DEV=1
pnpm desktop:build                 # static-export web + assemble cli-runtime + build desktop TS
pnpm desktop:package:mac           # DMG into apps/desktop/release/
pnpm desktop:package:win           # NSIS .exe into apps/desktop/release/
```

`desktop:build` builds the web UI as a Next.js static export (`apps/web/out`, served in the app over the `app://skipper` protocol) and runs `apps/desktop/build/prepare-cli-runtime.mjs`, which assembles `build/cli-runtime/` — the `skipper` CLI bundle plus its native embedder deps copied as real files (zero symlinks, so the Windows NSIS installer can't drop them). It also runs `prepare-uv.mjs`, which downloads the pinned `uv` binaries (mac arm64 + win x64) into `build/uv/` for `extraResources`; `after-pack.cjs` keeps only the target platform's binary.

### CLI (after `pnpm build`)

```bash
skipper knowledge extract <sha>    # Extract knowledge atoms from a git commit
skipper knowledge list|review      # Triage the pending-atom queue
skipper knowledge promote          # Add a curated atom from stdin
skipper projects register          # Install the post-commit extraction hook
skipper projects unregister|status # Remove the hook / show registration state
skipper session save|resume        # Cross-machine session handoff
skipper memory reindex|search|distill|serve  # Solutions-memory index: rebuild, query, distill lessons, MCP serve
skipper guard --root <path>        # PreToolUse hook: confine an agent run's Edit/Write/Bash to its worktree
```

## Git Workflow

Gitflow: `main` is release-only, `develop` is the integration branch (and the repo's default branch), work happens on `feature/issue-<N>-<slug>` branches. Conventions for branches, commit messages, issue/PR titles, and labels live in [`.claude/rules/conventions.md`](.claude/rules/conventions.md) — the skills in `.claude/skills/` (`/create-issue`, `/start-issue`, `/plan-issue`, `/implement-plan`, `/commit`, `/pr`, `/merge-pr`, `/release`) implement the day-to-day flow and are the preferred way to run it; `/goto` (jump to code) and `/verify` (build + drive the Electron app) round out the toolbox. Issue state is derived from git/GitHub (branch = in progress, PR = in review, closed = done); a GitHub Project board mirrors it as a prioritization view — the skills sync the board `Status` automatically via `.claude/scripts/board.sh` (contract in conventions.md).

Release workflows: `.github/workflows/beta.yml` (manual dispatch) builds beta releases; `.github/workflows/release.yml` (push to `main`) runs the full signed build + publish, but is currently **disabled** on GitHub and its external identifiers (update-feed domain, Polar product, private releases repo) are placeholders. Don't arm it or add release secrets without an explicit release decision.

## Coding Conventions

- TypeScript everywhere. Type all exported functions; rely on inference inside function bodies.
- Module systems, as they actually are: `packages/cli` and `apps/web` are ESM; `packages/shared` and `packages/sync` compile to CJS (they are consumed by the CJS Electron main); the Electron main bundle ends up CJS (so dynamic `require` is fine when needed, e.g. lazy `node-pty`).
- Use `node:fs/promises` + `node:path` for filesystem work. Use `node:path.join` with the platform separator — don't hand-build paths with `/`.
- One responsibility per file. The `packages/core/src/<area>/index.ts` files are the public surface; siblings are internals.
- Errors propagate inside `packages/core`. CLI commands and the Electron IPC layer are the boundaries that turn errors into user-facing messages.
- Prefer direct implementations over abstractions. No premature interfaces.
- Default to no comments. Never add comments that restate what the code does or narrate a change. Add one only when the *why* is non-obvious from the code — a real example is the `node-pty` lazy-load block in `apps/desktop/src/main.ts`.
- Do not log to stdout from `packages/core` — surface progress through callbacks so the caller decides how to present it.

## Important Notes

- **No workspace folder**: all app state lives in Electron `userData` (`~/.config/Skipper` on Linux, `%APPDATA%/Skipper` on Windows, `~/Library/Application Support/Skipper` on macOS) — `settings.json`, `knowledge/{pending,rejected,accepted}`, plus the orchestrator files (manifest, plans/, worktrees/, memory/, drafts/ — composer drafts, repo-instructions/ — per-repo agent instructions, graphs/ — per-repo Graphify indexes, tools/ — the uv-managed Python runtime). `<userData>/knowledge/` holds captured knowledge atoms — user data, never modify or delete it. The CLI resolves the same directory itself (no anchor file).
- LLM credentials come from the user's own CLIs (`claude` by default; `codex`/`copilot`/`gemini` authenticate through their own CLI sessions) or the OpenAI key in Settings. Never hardcode keys, never log them.
- The Electron main on macOS does **not** inherit the user's shell PATH — `apps/desktop/src/main.ts` runs an inline `fix-path` equivalent so that spawning `claude` (or any agent CLI) works regardless of where it's installed. Don't remove it.
- `node-pty` is loaded with a `try/catch require` because a native-binding load failure must not crash the app — the terminal is optional.
- **Open-core**: git + terminal are public core. There is currently **no feature gating in the code**; it gets designed if/when monetization needs it. The supporter update-entitlement path in `main.ts` is separate and present.
- `packages/sync` contains only the orchestrator seams: `backend.ts` (`diffFiles` three-way reconcile + the `SyncBackend` versioned-commit contract) and `manifest.ts`. They are intentionally consumerless — don't delete them as dead code.
- The Google OAuth Client ID + non-confidential Desktop client secret live in `apps/desktop/src/auth/oauth-config.ts` (gitignored; see `oauth-config.example.ts`). For OAuth client type "Desktop app" Google considers the secret non-confidential (PKCE is what actually secures the flow).
