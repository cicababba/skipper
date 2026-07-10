---
name: promote-knowledge
description: Capture an insight from the current conversation as a NestBrain knowledge atom — the escape hatch for things that aren't tied to a git commit (a Slack exchange, a doc-reading session, a design decision taken in chat). Triggered by natural-language phrases like "promuovi questo", "ricorda questo nella knowledge", "salva nella knowledge", "promote this", "remember this in the KB". Drafts the atom, shows it to the user, waits for OK/edits, then writes it to the pending review queue.
---

# promote-knowledge

Turn a specific insight from the current conversation into a knowledge atom in NestBrain's pending review queue. The user reviews it later in NestBrain's Knowledge page.

## When to invoke

Run when the user says any of:

- "promuovi questo" / "ricorda questo (nella knowledge)" / "salva nella knowledge"
- "promote this" / "remember this (in the KB)" / "save this to knowledge"

Don't invoke proactively — only when the user explicitly asks.

## Steps

### 1. Identify what to capture

From the user's words plus recent conversation:

- **Insight**: the *specific* thing worth remembering across projects. If the user pointed to something concrete ("quel pattern OAuth"), use that. Otherwise, the most recently discussed substantive idea — not a generic recap of the session.
- **Project**: auto-detect by walking up `cwd` to find `.nestbrain/`, then checking if cwd sits under `<nestbrain_root>/Projects/<name>/`. If yes, that's the default project. Otherwise, ask the user once: *"Su quale progetto lo attribuiamo?"*

### 2. Draft the atom

- **Title**: 5–12 words, declarative, *leads with the insight* (not "discussed OAuth" but "OAuth Desktop secrets are non-confidential — PKCE is the security").
- **Body**: 3–8 lines markdown, no headings. Self-contained — readable in 6 months without conversation context.
- **Tags**: 3–6 short tags.
- **Score**: 7. The user is explicitly promoting, so it's non-trivial by definition.

### 3. Resolve CLI invocation

Fallback chain:

1. `command -v nestbrain` → use `nestbrain`
2. macOS: `/Applications/NestBrain.app/Contents/Resources/web/apps/web/nestbrain.bundle.cjs` → use `node "<path>"`
   Windows: `%LOCALAPPDATA%\Programs\NestBrain\resources\web\apps\web\nestbrain.bundle.cjs` → use `node "<path>"`
3. `<nestbrain_root>/Projects/nestbrain/packages/cli/src/index.ts` → use `npx tsx "<path>"`
4. None → reply *"NestBrain CLI not found."* and stop.

### 4. Show the draft and wait for confirmation

```
📝 Proposed atom:
**Title:** <title>
**Project:** <project>
**Tags:** <tag1>, <tag2>, …

<body>
```

Then ask: *"Va bene così, o vuoi modificare titolo/body/tag prima di salvare?"* (or English equivalent).

Wait. Don't write until the user confirms. If they edit, fold the edits in and re-show.

### 5. Write to the pending queue

Pipe a JSON object to the CLI:

```bash
echo '<JSON>' | <CLI> knowledge promote
```

Where `<JSON>` is `{"title":"…","body":"…","project":"…","tags":[…],"score":7}` — properly escaped for the shell. Prefer here-doc / `printf` with single-quoted JSON to avoid escaping headaches.

### 6. Confirm

Reply with one line matching the user's language:

> Salvato nella coda di review. Apri NestBrain → Knowledge per accettarlo.
> Saved to the review queue. Open NestBrain → Knowledge to accept it.

## Hard rules

- **Never write directly to the wiki.** Always goes through the pending queue. The user has to confirm in the UI before it lands in knowledge.
- **No silent writes.** Always show the draft and wait for OK. The user might not actually want it captured, or might want a different framing.
- **Single atom per invocation.** If multiple insights came up, ask which one to capture (or capture sequentially with one confirmation each). Don't batch.
- **No thinking out loud.** Show: draft → wait for OK → write → one-line confirm. That's the whole flow.
