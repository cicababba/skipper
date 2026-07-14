---
name: start_session
description: Start a new work session in the Skipper workspace. Triggered when the user says "Buongiorno, Claude" or "Good morning, Claude". Creates a timestamped session file in Daily/, shows a recap of the previous session, and begins logging macro-tasks across the Projects touched during the session.
---

# start_session

You run this skill when the user greets you with **"Buongiorno, Claude"** or **"Good morning, Claude"** (case-insensitive, comma optional).

**Path resolution:** every path in this skill (`Daily/`, `Projects/<name>/.nest/STATE.md`, etc.) resolves against `<skipper_root>`, not your current working directory. See the "Finding the Skipper root" section of `<skipper_root>/CLAUDE.md`. Use absolute paths when reading/writing.

## Step 1 — Check for an already-open session

List `<skipper_root>/Daily/*.md`. Find the most recent by filename (they are sorted lexicographically by `YYYY-MM-DD_HH-mm-ss.md`). Read its frontmatter.

- **If `status: open`** → the user already has an active session. **Do not open a new one.** Respond: *"There's already an open session from [time] — close it with 'Arrivederci, Claude' before starting a new one."* Stop here.
- **If `status: closed` or `Daily/` is empty** → proceed to Step 2.

## Step 2 — Show a recap of the previous session

Find the most recent **closed** session in `<skipper_root>/Daily/` (skip the one you are about to create). Read its `## Summary` section.

- If the previous session is from **today** → open with *"In your previous session today you..."*
- If the previous session is from **yesterday** → open with *"Yesterday you..."*
- If the previous session is from **2+ days ago** → open with *"In your last session (N days ago) you..."*
- If there is **no previous closed session** → open with a friendly *"This looks like your first session. Welcome."* and skip the recap.

Then print **3–5 short bullets** distilled from the previous session's Summary + Next sections. Macro level only — the goal is orientation, not a full replay. Keep it tight.

## Step 3 — Create the new session file

Create `<skipper_root>/Daily/YYYY-MM-DD_HH-mm-ss.md` using the current local time. Format:

```markdown
---
session_id: YYYY-MM-DD_HH-mm-ss
started_at: <ISO-8601 with timezone offset>
ended_at: null
status: open
projects: []
---

# Session YYYY-MM-DD HH:mm

## Log

<!-- macro-task entries go here, one per line, as they happen -->
```

Leave `## Summary`, `## Next`, and `## Git` sections **unwritten** — they will be filled in by the `end_session` skill.

## Step 4 — Acknowledge and await instructions

Respond with one short sentence confirming the session is open, e.g. *"Session started. What shall we work on?"*

---

## Logging rules during the session (applies until `end_session` runs)

Once the session is open, append to the session file's `## Log` section **after each completed macro-task**. A macro-task is a unit of work a user would describe in one sentence — not an individual file edit or tool call.

**Examples of what to log:**
- `- 09:42 — [Projects/my-api] Scaffolded FastAPI app with Postgres and initial /users routes`
- `- 10:15 — [Projects/landing] Fixed hero layout bug on mobile`
- `- 11:03 — [workspace] Ingested 3 arXiv papers on retrieval-augmented generation and recompiled wiki`

**Do not log:**
- Individual file edits ("edited main.ts line 42")
- Individual tool calls or commands
- Internal deliberation or exploration that didn't produce a result

**Path tag rules:**
- Work inside `Projects/<name>/` → tag `[Projects/<name>]`
- Work outside `Projects/` (notes, wiki, settings) → tag `[workspace]`

**Projects tracking:** every time you log a task tagged `[Projects/<name>]`, make sure `<name>` is present in the frontmatter `projects:` array. Add it if missing.

**First time a new project appears in the session:** ask the user one short question — *"What's this project about, in one line?"* — and remember the answer. You will write it into that project's `.nest/STATE.md` as `Purpose:` when `end_session` runs. Do not interrogate the user beyond this one question.

**Token discipline:** be sparing. Fewer, meaningful log entries > many granular ones. When in doubt, skip.
