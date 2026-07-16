---
name: plan-issue
description: Analyze a GitHub issue, explore the codebase, ask clarifying questions, and create an implementation plan. Use before coding to align on approach.
---

# Plan Issue Implementation

## Instructions

### 1. Determine the issue number

**If passed as argument** (e.g., `/plan-issue #123` or `/plan-issue 123`):
- Use that issue number

**If no argument**, deduce from current branch:
```bash
git branch --show-current
```
- Extract issue number from branch name (e.g., `feature/issue-123-description` → `123`)

**If not found**, ask the user:
> Which issue would you like to plan? (e.g., #123)

### 2. Fetch issue details

```bash
gh issue view <number> --json number,title,labels,body,comments
```

Display a summary:
```
## Issue #<number>: <title>

<body summary>
```

### 3. Enter Plan Mode

Use the `EnterPlanMode` tool to signal you're entering planning phase.

### 4. Analyze the codebase

Based on the issue requirements:

1. **Identify relevant files**: Use Glob and Grep to find related code — the scope
   prefix in the issue title tells you where to look (`desktop` → `apps/desktop`,
   `web` → `apps/web`, `core`/`cli`/`db`/`shared`/`sync` → `packages/<scope>`)
2. **Read key files**: Understand current implementation
3. **Map dependencies**: What components/modules are affected?
4. **Check existing patterns**: How are similar features implemented?

### 5. Ask clarifying questions

**IMPORTANT**: Do NOT make assumptions. Ask the user about:

- Unclear requirements
- Edge cases not mentioned
- UI/UX preferences (if applicable)
- Technical choices (when multiple valid approaches exist)
- Priority of sub-features (if issue is large)

Use `AskUserQuestion` tool for structured questions, or ask directly in chat.

Examples:
- "The issue mentions 'error handling' - should we surface this in the UI, log it, or both?"
- "There are 2 approaches for this: A does X, B does Y. Which do you prefer?"
- "The issue doesn't specify behavior when Z happens. What should we do?"

### 6. Present the implementation plan

Once you have enough information, present a clear plan:

```
## Implementation Plan for #<number>

### Summary
<1-2 sentences describing what will be done>

### Files to modify
- `path/to/file1.ts` - <what changes>
- `path/to/file2.tsx` - <what changes>

### New files (if any)
- `path/to/new-file.ts` - <purpose>

### Steps
1. <First step>
2. <Second step>
3. ...

### Testing approach
- <What will be tested manually>
- <What automated tests will be written>

### Questions resolved
- <Decision 1>
- <Decision 2>
```

### 7. Wait for user confirmation

Ask:
> Does this plan look good? Let me know if you want to adjust anything, otherwise I'll hand it to the implementer.

**Do NOT start coding until the user confirms.**

### 8. After confirmation: Write the plan document

1. Exit plan mode
2. Write the plan to `.claude/plans/issue-<N>.md` (create the directory if missing; gitignored)

The document is the **only context** the implementer receives — it must be
self-contained. Include everything learned during exploration, not just the
plan summary shown to the user:

```markdown
# Plan: #<number> <issue title>

## Goal
<what and why, 2-3 sentences>

## Context
<key facts from codebase exploration the implementer must know:
current behavior, relevant types/functions with file:line, gotchas,
patterns to follow, things that look related but must NOT be touched>

## Decisions
<clarifications resolved with the user, with the reasoning>

## Files to modify
- `path/to/file1.ts` — <what changes>

## New files
- `path/to/new-file.ts` — <purpose>

## Steps
1. <ordered, concrete steps>

## Verification
<which lint/test/build commands must pass; what to check manually>

## Out of scope
<explicitly excluded work, so the implementer doesn't drift>
```

### 9. Delegate implementation

Spawn the `implementer` subagent (it runs on Opus) via the Agent tool
(`subagent_type: "implementer"`), passing the plan file path and issue number
in the prompt. Wait for its report.

### 10. Review the result

You (the planning model) review the implementer's work:

1. Read its report — surface deviations and conflicts to the user verbatim
2. Review `git diff` against the plan: correctness, scope drift, convention violations
3. If something is wrong, send the implementer a follow-up (SendMessage) with
   the specific fix — don't fix it inline yourself unless it's trivial
4. When the diff is sound, show the user the manual testing checklist from
   the plan's Verification section

### 11. After manual testing confirmation: Write tests

Only after user confirms manual testing passed: delegate test-writing to the
same implementer agent (SendMessage follow-up), then review the tests as in
step 10.

## Notes

- This skill focuses on **alignment before coding**
- The goal is zero surprises: user knows exactly what will happen
- Better to ask one extra question than to redo work
- Keep the plan concise but complete
- **Model split**: planning and review run on the main session's model;
  coding runs on the `implementer` subagent (Opus). The plan document is the
  handoff artifact — if a plan exists but the session was lost, use
  `/implement-plan` to resume from the document.
