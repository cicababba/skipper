# Skipper *(working title)*

**One inbox for every issue assigned to you — across GitHub, Bitbucket, Jira, Linear — where each issue arrives already planned, scored with a verifiable confidence, and one click away from becoming a draft PR that gets shepherded all the way to merge.**

![Status](https://img.shields.io/badge/status-pivot%20in%20progress-orange) ![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue) ![License](https://img.shields.io/badge/license-GPL--3.0-blue) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

> 🚧 **This repo is mid-pivot and not usable yet.** It was born as [NestBrain](https://nestbrain.app), an LLM-compiled personal knowledge base, and is being rebuilt into the product described below. The work is public: start from the [v1 epic (#3)](../../issues/3), the full vision and decision log lives in [`docs/DIRECTION.md`](docs/DIRECTION.md) (in Italian). NestBrain itself keeps living — and being sold and maintained — at [nestbrain.app](https://nestbrain.app).

---

## The idea

Coding agents can write the code — that part is fast becoming a commodity. What's scarce is the layer **above** them: deciding *which* issues are worth handing to an agent, *how* to approach them, with *how much* confidence — and carrying each one all the way to a merged PR instead of firing and forgetting.

Skipper is that layer. It orchestrates coding agents (Claude Code first); it doesn't reimplement them.

| It is | It is not |
|---|---|
| A dashboard of your in-flight work across platforms | Another editor / IDE |
| An orchestrator that plans, develops, and watches PRs | A coding agent written from scratch |
| A judge that tells you *which* issues to trust to AI | A knowledge base you feed by hand |
| A desktop app talking directly to the platforms | A service with its own backend |

## The loop

```
new / assigned issue ──▶ eager plan (background) ──▶ confidence score
                                                          │
                                        high ─────────────┼───────────── low
                                          │                                │
                                          │                you fix the plan first
                                          ▼                                │
                                     coding queue ◀────────────────────────┘
                                          │  (WIP-limited, default 1 per repo)
                                          ▼
                          isolated git worktree + coding agent
                                          ▼
                        agent review (fresh context, max 2 rounds)
                                          ▼
                        your review — diff in-app, editable, pre-PR
                                          ▼
                    draft PR ──▶ shepherded: review comments send it
                                 back to coding, same worktree ──▶ merge
                                          ▼
                        solutions memory (problem → plan → diff → outcome)
```

Two things make this different from a wrapper:

- **Confidence is verifiable, not vibes.** Not "the LLM feels 90% sure" — a composite of checkable signals: do the files the plan cites actually exist (*groundedness*)? Do independent plans agree (*convergence*)? Does an adversarial critic tear it apart (*critic*)? Does the issue even have acceptance criteria? The score isn't decoration: it decides **where you intervene** — high confidence skips the plan gate and you review only the diff; low confidence stops *before* burning machine time.
- **Opening the PR is not the end.** The app watches the PR: change requests send the issue back to coding in the same worktree, the agent addresses the comments and repushes. Merged work is captured as *problem → plan → diff → outcome* — retrieval context for the machine, a self-writing engineering journal for you.

## Roadmap

- **v1 — the loop + the judgment**: GitHub, eager plan, confidence-gated approval, worktree coding, agent + human review, draft PR, shepherding → [epic #3](../../issues/3) *(in progress)*
- **v2 — the memory**: capture at scale, retrieval into planning, memory as a confidence signal
- **v3 — the aggregation**: Bitbucket + Jira/Linear, one queue across orgs
- **v4 — the team**: parallel agents, shared queue, metrics

No dates. Watch the repo.

## Heritage

Skipper is built on the NestBrain codebase, and reuses its best parts: the Electron + Next.js desktop shell with editor, file tree and real PTY terminal; the desktop OAuth stack; local embeddings (ONNX, no API); and a battle-tested "observe → reconcile → track state" engine being repurposed as the orchestrator. Everything still says `nestbrain` in package names, IPC channels and configs — the coordinated rename is tracked in [#16](../../issues/16) and waits for the final product name.

## Development

```bash
# Node 20+, pnpm
pnpm install
pnpm desktop:build
pnpm --filter @nestbrain/desktop start
```

Gitflow: `main` is release-only, `develop` is the integration branch. Conventions for branches, commits, and issue/PR titles live in [`.claude/rules/conventions.md`](.claude/rules/conventions.md).

### OAuth credentials (optional)

Sign-in works out of the box only in official builds. Source builds run with placeholder credentials — each provider shows as "unconfigured" until you supply your own client in `apps/desktop/src/auth/oauth-config.ts` (gitignored; see [`oauth-config.example.ts`](apps/desktop/src/auth/oauth-config.example.ts) for setup steps) or via env vars / `apps/desktop/.env.local`:

- **Google** (identity for the supporter entitlement): `NESTBRAIN_GOOGLE_CLIENT_ID` + `NESTBRAIN_GOOGLE_CLIENT_SECRET` — an OAuth "Desktop app" client from Google Cloud Console.
- **GitHub** (issue/PR orchestration): `NESTBRAIN_GITHUB_CLIENT_ID` + `NESTBRAIN_GITHUB_CLIENT_SECRET` — a GitHub App with "Expire user authorization tokens" enabled, callback URLs `http://127.0.0.1:8127/callback`, `:8128`, `:8129`, and permissions Issues (read), Pull requests (read & write), Metadata (read), Email addresses (read).

## Author

Created by **Mike Gazzaruso** ([NextEpochs](https://github.com/mikegazzaruso)).
Copyright © 2026 NextEpochs.

## License

[GNU General Public License v3.0](LICENSE).
