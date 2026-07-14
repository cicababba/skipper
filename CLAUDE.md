# Skipper (pivoted from NestBrain)

**This codebase is pivoting.** It was born as NestBrain (LLM-powered personal knowledge base, sold at [nestbrain.app](https://nestbrain.app)); it is becoming a **cross-platform issue inbox + orchestration layer on top of coding agents**: assigned issues arrive with an eager plan and a verifiable confidence score, coding runs in isolated worktrees behind a human gate, PRs are shepherded to merge. Vision, decisions, and phasing live in [`docs/DIRECTION.md`](docs/DIRECTION.md) (authoritative, in Italian). Work is mapped on GitHub: epic #3 (v1 loop) with sub-issues #4–#15, plus #1 (open-core boundary) and #2 (demolition of the old product surface).

**Skipper is the product name** (decided 2026-07-14; the repo codename was promoted). The coordinated rename landed with #16: package scopes are `@skipper/*`, the IPC prefix is `skipper:*`, the CLI is `skipper`, env vars are `SKIPPER_*`, appId is `com.nextepochs.skipper`. Historical NestBrain references in docs are intentional. Skipper is a **clean break** for installs: no migration from NestBrain userData/workspaces — both apps can coexist on one machine.

The old product surface (wiki ingest/compile pipeline, Google Drive sync, Team Server client, `packages/db`) was demolished in #2; the private-modules overlay machinery (open-core gating seam) was removed with #16 — feature gating gets redesigned if/when monetization needs it. What survives from NestBrain: the Electron shell (PATH fixes, embedded server), editor + file tree + terminal, the Google OAuth desktop flow, the LLM provider layer, embeddings + vectorstore (future solutions memory), the knowledge-atom pipeline (structured extraction prototype), and the `SyncBackend`/manifest seams the orchestrator builds on. NestBrain 1.16.x remains sold and maintained **from its own upstream repo** — this repo's release pipeline is intentionally **disarmed** (zero Actions secrets, publishes nothing) until the distribution cutover (#17), and external identifiers in it (update-feed domain, Polar product, private releases repo) are placeholders to be provisioned at that cutover. Don't add release secrets here before that cutover is intentional.

## Repo Layout (pnpm monorepo)

```
skipper/
├── apps/
│   ├── desktop/                # Electron 33 shell (main + preload + builder config)
│   │   ├── src/main.ts         # Electron main: PATH fix, IPC, embedded server
│   │   ├── src/git.ts          # Git backend (public core, #1)
│   │   ├── src/terminal.ts     # PTY session manager (public core, #18)
│   │   ├── src/auth/           # Multi-provider OAuth desktop flow (Google PKCE, GitHub App; loopback)
│   │   ├── src/preload.ts      # Renderer-safe IPC bridge
│   │   └── build/              # electron-builder hooks, icons, NSIS installer
│   └── web/                    # Next.js 16 + React 19 UI (runs as standalone inside Electron)
│       └── src/{app,components,lib,types}
├── packages/
│   ├── cli/                    # `skipper` CLI (commander): knowledge, projects, session
│   ├── core/                   # Domain logic
│   │   └── src/{llm,vectorstore,knowledge}
│   ├── shared/                 # Types and constants (auth types live here so main + renderer share them)
│   └── sync/                   # Orchestrator seams kept from the retired Drive engine
│       └── src/{backend,manifest,types}   # diffFiles + SyncBackend contract, local manifest
├── data/                       # Local-dev workspace (legacy artifacts; untouched by the build)
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
- **LLM providers** (`packages/core/src/llm/`): `claude-cli` (default — spawns the user's `claude` CLI), `openai`, `ollama`
- **Embeddings**: `@huggingface/transformers` running ONNX locally (`Xenova/all-MiniLM-L6-v2`), in `packages/core/src/vectorstore`
- **Auth**: multi-provider multi-account OAuth desktop flow (loopback redirect) behind a `ProviderConfig` registry in `apps/desktop/src/auth/`. Google: PKCE, identity-only scopes — proves the email for the supporter update entitlement (`getIdToken`, Google-only path). GitHub: GitHub App user-to-server flow, fixed loopback ports 8127–8129, expiring tokens with refresh rotation — feeds the orchestrator (#5+). Accounts + tokens live in one `auth.enc` (v2 multi-account format, legacy single-session migrated on load) encrypted via Electron `safeStorage`.
- **Testing**: Vitest (configured at root, very thin coverage today)
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
pnpm desktop:build                 # build web standalone + copy assets + build desktop TS
pnpm desktop:package:mac           # DMG into apps/desktop/release/
pnpm desktop:package:win           # NSIS .exe into apps/desktop/release/
```

`desktop:build` runs `apps/desktop/build/copy-assets.mjs` and `prepare-standalone.mjs` — these dereference pnpm symlinks and promote hoisted deps so the packaged app works on Windows.

### CLI (after `pnpm build`)

```bash
skipper knowledge extract <sha>    # Extract knowledge atoms from a git commit
skipper knowledge list|review      # Triage the pending-atom queue
skipper knowledge promote          # Add a curated atom from stdin
skipper projects register          # Install the post-commit extraction hook
skipper session save|resume        # Cross-machine session handoff
```

## Git Workflow

Gitflow: `main` is release-only (**every push to `main` fires `.github/workflows/release.yml`** — full signed build + publish to Polar/update feed), `develop` is the integration branch, work happens on `feature/issue-<N>-<slug>` branches. Conventions for branches, commit messages, issue/PR titles, and labels live in [`.claude/rules/conventions.md`](.claude/rules/conventions.md) — the skills in `.claude/skills/` (`/create-issue`, `/start-issue`, `/plan-issue`, `/commit`, `/pr`, `/merge-pr`, `/release`) implement the day-to-day flow and are the preferred way to run it. No project board: issue state is derived from git/GitHub (branch = in progress, PR = in review, closed = done).

## Coding Conventions

- TypeScript everywhere. Type all exported functions; rely on inference inside function bodies.
- ESM in `packages/*` and `apps/web`; the Electron main bundle ends up CJS (so dynamic `require` is fine when needed, e.g. lazy `node-pty`).
- Use `node:fs/promises` + `node:path` for filesystem work. Use `node:path.join` with the platform separator — don't hand-build paths with `/`.
- One responsibility per file. The `packages/core/src/<area>/index.ts` files are the public surface; siblings are internals.
- Errors propagate inside `packages/core`. CLI commands, Next.js route handlers, and the Electron IPC layer are the boundaries that turn errors into user-facing messages.
- Prefer direct implementations over abstractions. No premature interfaces.
- Default to no comments. Add one only when the *why* is non-obvious — a real example is the `node-pty` lazy-load block in `apps/desktop/src/main.ts`.
- Do not log to stdout from `packages/core` — surface progress through callbacks so the caller decides how to present it.

## Important Notes

- **No workspace folder** (removed with #39): all app state lives in Electron `userData` (`~/.config/Skipper` on Linux, `%APPDATA%/Skipper` on Windows, `~/Library/Application Support/Skipper` on macOS) — `settings.json`, `knowledge/{pending,rejected,accepted}`, plus the orchestrator files (manifest, plans/, worktrees/, memory/). `<userData>/knowledge/` holds captured knowledge atoms — user data, never modify or delete it. The CLI resolves the same directory itself (no anchor file).
- LLM credentials come from the user's `claude` CLI auth (default) or the OpenAI key in Settings. Never hardcode keys, never log them.
- The Electron main on macOS does **not** inherit the user's shell PATH — `apps/desktop/src/main.ts` runs an inline `fix-path` equivalent so that spawning `claude` works regardless of where it's installed. Don't remove it.
- `node-pty` is loaded with a `try/catch require` because a native-binding load failure must not crash the app — the terminal is optional.
- **Open-core**: git + terminal are public core (decision #18). The private-modules overlay machinery (module registry, dev-impl seam, `useModules()`) was removed with #16 — there is currently **no feature gating in the code**; it gets redesigned when monetization returns (Polar keys). The supporter update-entitlement path in `main.ts` is separate and still present.
- `packages/sync` now contains only the orchestrator seams: `backend.ts` (`diffFiles` three-way reconcile + the `SyncBackend` versioned-commit contract) and `manifest.ts`. They are intentionally consumerless until the new loop lands — don't delete them as dead code.
- The Google OAuth Client ID + non-confidential Desktop client secret live in `apps/desktop/src/auth/oauth-config.ts` (gitignored; see `oauth-config.example.ts`). For OAuth client type "Desktop app" Google considers the secret non-confidential (PKCE is what actually secures the flow).
