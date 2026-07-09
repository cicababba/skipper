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
> Does this plan look good? Let me know if you want to adjust anything, otherwise I'll start implementing.

**Do NOT start coding until the user confirms.**

### 8. After confirmation: Implement

Once confirmed:
1. Exit plan mode
2. Implement according to the plan
3. When done, show manual testing checklist

### 9. After manual testing confirmation: Write tests

Only after user confirms manual testing passed:
1. Write automated tests for the new functionality
2. Update existing tests if behavior changed

## Notes

- This skill focuses on **alignment before coding**
- The goal is zero surprises: user knows exactly what will happen
- Better to ask one extra question than to redo work
- Keep the plan concise but complete
