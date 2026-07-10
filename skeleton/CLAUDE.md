# NestBrain

You are working inside a **NestBrain**: a personal project + knowledge workspace managed by [NestBrain](https://github.com/mikegazzaruso/NestBrain). Think of it as a folder-based OS where notes, captured engineering knowledge, and real code projects live side by side in one integrated environment.

## Finding the NestBrain root

You may be launched from the NestBrain root itself, or from deep inside a subdirectory (e.g. `Projects/my-api/`). **Do not assume your current working directory is the NestBrain root.**

To find the NestBrain root: starting from your current working directory, walk **up** the directory tree until you find a directory that contains **all of**: `CLAUDE.md` (this file), `.nestbrain/`, `Daily/`, and `Skills/`. That directory is `<nestbrain_root>`.

**Every path mentioned in this document and in the session skills** — `Daily/`, `Skills/`, `Projects/`, `.nestbrain/`, etc. — resolves against `<nestbrain_root>`, never against your current working directory. When you read, write, or list any of these, use the absolute path `<nestbrain_root>/<path>`.

## Prime directive

- `.nestbrain/` belongs to **NestBrain**. Everything else belongs to the **user**.
- Never touch `.nestbrain/` — it holds internal state (knowledge atoms, vector index, settings).

## Directory map

| Path                     | Owner              | Purpose                                                                 |
|--------------------------|--------------------|-------------------------------------------------------------------------|
| `.nestbrain/`             | NestBrain           | Knowledge atoms, vector index, settings. Never modify.                  |
| `Projects/<name>/`       | User + Claude Code | Real code projects. Each has its own terminal and optionally its own nested `CLAUDE.md`. |
| `Projects/<name>/.nest/` | Skills             | Project state files maintained by session skills. Do not edit by hand.  |
| `Daily/`                 | User + Skills      | Daily notes and session logs (see Sessions below).                      |
| `Skills/`                | User               | Skill definitions. Each subfolder is a skill with a `SKILL.md`.         |
| `Business/`, `Context/`, `Library/` | User    | Structured personal notes. Edit on request.                             |
| `.trash/`                | NestBrain           | Soft-deleted files. Treat as recoverable; don't auto-empty.             |
| `CLAUDE.md` (this file)  | NestBrain           | Workspace orientation. You are reading it.                              |

## How to behave in each area

- **Inside `Projects/<foo>/`**: act as a normal coding assistant. If that project has its own `CLAUDE.md`, **that file wins** over this one for project-specific rules. Use the integrated terminal for commands.
- **In notes areas** (`Daily/`, `Business/`, `Context/`, `Library/`): act as a writing/knowledge assistant. Use markdown with YAML frontmatter and `[[wikilinks]]` for cross-references (Obsidian-compatible).

## NestBrain CLI

```
nestbrain knowledge extract <sha>   # Extract knowledge atoms from a git commit
nestbrain knowledge list            # List atoms in the pending queue
nestbrain knowledge review          # Interactively triage pending atoms
nestbrain projects register         # Install the post-commit hook in a repo
nestbrain session save|resume       # Cross-machine session handoff
```

## Conventions

- All markdown files use YAML frontmatter.
- Internal links use `[[wikilinks]]`.
- Use relative paths (portability).
- Default to English. If the user writes in another language, match theirs.

## Promoting an insight — the `promote-knowledge` skill

When the user explicitly asks you to remember something from the current conversation into the knowledge base, open `Skills/promote-knowledge/SKILL.md` and follow it. Triggers:

| User pattern                                                      | Action                          |
|-------------------------------------------------------------------|---------------------------------|
| "promuovi questo" / "ricorda questo nella knowledge"              | Draft an atom for review        |
| "salva nella knowledge" / "save this to knowledge"                | Draft an atom for review        |
| "promote this" / "remember this in the KB"                        | Draft an atom for review        |

The skill drafts the atom, **shows it to the user**, waits for confirm/edit, then writes it to the pending review queue. The user accepts it later from NestBrain → Knowledge.

Don't invoke proactively — only when the user explicitly asks. (Knowledge atoms tied to git commits land in pending automatically via the post-commit hook; this skill is for insights that aren't tied to a commit.)

## Sessions

This workspace uses **session skills** to track work over time so future sessions know where to pick up. The skills live in `Skills/start_session/` and `Skills/end_session/`.

### Trigger phrases

| Phrase (case-insensitive, comma optional)                 | Action                                          |
|-----------------------------------------------------------|-------------------------------------------------|
| `Buongiorno, Claude` / `Good morning, Claude`             | Run the `start_session` skill                   |
| `Arrivederci, Claude` / `Goodbye, Claude`                 | Run the `end_session` skill                     |

When the user says one of these, open the corresponding skill file (`Skills/<skill>/SKILL.md`) and follow its instructions exactly.

### On every new Claude Code conversation — orphan session check

**Before responding to the user's first message**, you must check for an orphaned open session. This applies whether you were launched from the NestBrain root or from inside a project subdirectory — always resolve paths against `<nestbrain_root>` as described above.

1. List files in `<nestbrain_root>/Daily/` matching `*.md` and find the most recent by filename (they are timestamped `YYYY-MM-DD_HH-mm-ss.md`).
2. Read its YAML frontmatter. If `status: open`, it is an orphaned session (the user forgot to close it).
3. Announce it to the user in one sentence — e.g. *"There's still an open session from [time] — I'll continue it. Say 'Arrivederci, Claude' when you want to close it."* — and from now on, treat that file as the active session: append to its `## Log` as macro-tasks complete, per the `start_session` skill's logging rules.
4. If the most recent session is `status: closed` (or `Daily/` is empty), do nothing special. Wait for the user to say "Buongiorno, Claude" before starting a new one.

This check must run once at the start of the conversation, not on every message.

### What gets logged during an active session

Once a session is active (either freshly started or resumed from an orphan), append a one-line entry to the session file's `## Log` section **after each completed macro-task** — not after each tool call. Examples of macro-tasks:

- Scaffolding a new project
- Implementing a feature end-to-end
- Fixing a bug
- A significant refactor

Log format: `- HH:mm — [Projects/<name>] one-line macro description`. Use `[workspace]` for work outside `Projects/` (notes, etc.).

**Keep it macro.** Do not log individual file edits, individual tool calls, or internal deliberation. Err on the side of fewer, meaningful entries. Token-efficient: the point is future-session context, not a full transcript.

## Safety rules

- Never delete `.nestbrain/raw/` — captured knowledge atoms, not regenerable.
- User notes are *not* regenerable. When in doubt about ownership, ask.
- Prefer moving files to `<nestbrain_root>/.trash/` over hard-deleting.

---

*NestBrain — by [Mike Gazzaruso / NextEpochs](https://github.com/mikegazzaruso). Learn more: https://github.com/mikegazzaruso/NestBrain*
