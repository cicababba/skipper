---
name: end_session
description: Close the current work session in the Skipper workspace. Triggered when the user says "Arrivederci, Claude" or "Goodbye, Claude". Writes the session Summary, Next steps, Git snapshot, and updates per-project STATE.md files for every project touched during the session.
---

# end_session

You run this skill when the user says **"Arrivederci, Claude"** or **"Goodbye, Claude"** (case-insensitive, comma optional).

**Path resolution:** every path in this skill (`Daily/`, `Projects/<name>/.nest/STATE.md`, etc.) resolves against `<skipper_root>`, not your current working directory. See the "Finding the Skipper root" section of `<skipper_root>/CLAUDE.md`. Use absolute paths when reading/writing. For git commands, use `git -C <skipper_root>/Projects/<name>` so you don't depend on cwd.

## Step 1 — Find the active session

List `<skipper_root>/Daily/*.md`, take the most recent by filename, read its frontmatter.

- **If `status: open`** → this is the session to close. Proceed.
- **If `status: closed` or `Daily/` is empty** → respond *"No active session to close."* and stop.

## Step 2 — Write the Summary section

Add a `## Summary` section to the session file with **3–5 macro bullets**, grouped by project. One bullet per meaningful outcome. Not a copy of the Log — a distillation.

Example:
```markdown
## Summary

- **Projects/my-api** — Scaffolded FastAPI + Postgres, wired /users and /auth routes, set up Alembic migrations
- **Projects/landing** — Fixed mobile hero layout and deployed preview
- **workspace** — Ingested 3 RAG papers and recompiled the wiki
```

Keep it tight. Token discipline.

## Step 3 — Write the Next section

Add a `## Next` section. This is **the most important part for the next session to pick up work.** For each project touched, write:

- What's unfinished or in progress
- Open decisions or questions
- The logical next step

Example:
```markdown
## Next

- **Projects/my-api** — /auth routes stubbed but JWT verification not yet implemented. Decide between `python-jose` and `authlib`. Next: wire login endpoint end-to-end.
- **Projects/landing** — Ready for production deploy pending client signoff on hero copy.
```

3–6 short bullets total. If a project is in a clean "nothing pending" state, say so in one line rather than omitting it.

## Step 4 — Write the Git section

For each project listed in the frontmatter `projects:` array, if `<skipper_root>/Projects/<name>/.git/` exists, run `git -C <skipper_root>/Projects/<name> status --porcelain` and `git -C <skipper_root>/Projects/<name> rev-parse --short HEAD` (plus `symbolic-ref --short HEAD` for the branch) and add **one compact line** with its current state. Format:

```markdown
## Git

- **Projects/my-api** — `feature/auth @ a3f8c21 (dirty: 4 files)`
- **Projects/landing** — `main @ 7bd1e05 (clean)`
```

Fields: current branch, short commit hash (7 chars), dirty status. If dirty, include the count of modified files. Nothing more — no diff, no file list, no log. If a project is not a git repo, skip it silently. If `git` is not available, skip the whole section.

## Step 5 — Update per-project STATE.md files

For every project in the frontmatter `projects:` array, update `<skipper_root>/Projects/<name>/.nest/STATE.md`. Create the `.nest/` directory and the file if they don't exist.

**STATE.md schema:**

```markdown
---
project: <name>
last_touched: <ISO-8601>
last_session: <session_id>
---

# <name>

**Purpose:** <one-line macro description>

**Current status:** <where we are now, 1–2 lines max>

**Next up:** <what to do next, 1–2 lines max>
```

**Rules:**
- **Purpose**: if STATE.md does not exist yet and you asked the user during `start_session` what the project is about, use that answer. If STATE.md already exists, keep the existing Purpose unchanged (unless the user's work this session fundamentally changed the project's scope — in that case update it, but default to preserving).
- **Current status**: reflect where the project actually is right now, after this session. Overwrite the previous value.
- **Next up**: the immediate next step. Overwrite the previous value.
- **last_touched** and **last_session**: always updated to the current session.

Keep each field to **1–2 lines maximum**. This file is meant to be read by a future session in seconds. Bloated STATE files defeat their purpose.

## Step 6 — Close the session

Update the session file's frontmatter:

- `ended_at: <current ISO-8601 with timezone>`
- `status: closed`

## Step 7 — Farewell message to the user

Respond with a short human farewell in chat (not written to the file). Include:

- How long the session lasted (from `started_at` to `ended_at`, rounded to minutes or hours)
- How many projects were touched
- A brief sign-off

Example: *"Session closed. 2h 14m across 3 projects. See you next time."*

---

## Token discipline reminder

Every section of the session file and every STATE.md field should be **compact**. The goal is that a future Claude Code session can read the previous session's Summary + Next sections (or a project's STATE.md) in under 30 seconds and know exactly where to start. If a section is getting long, cut it.
