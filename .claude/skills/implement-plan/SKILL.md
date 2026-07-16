---
name: implement-plan
description: Hand an existing plan document to the Opus implementer subagent and review the result. Use when a plan file already exists (written by /plan-issue) and coding should start or resume.
---

# Implement an Existing Plan

Counterpart of `/plan-issue` for when the plan document already exists (fresh
session, or plan written earlier). Planning/review stay on the main session's
model; coding runs on the `implementer` subagent (Opus).

## Instructions

### 1. Locate the plan

- Argument is an issue number (`/implement-plan #123`) → `.claude/plans/issue-123.md`
- Argument is a path → use it directly
- No argument → derive the issue number from the current branch
  (`feature/issue-<N>-...`), else list `.claude/plans/` and ask the user

If the file doesn't exist, say so and suggest `/plan-issue`.

### 2. Sanity-check the plan

Read the plan. Quickly verify it's still valid: spot-check that the files it
lists still exist and the current branch matches the issue. If the plan looks
stale (files moved, work already partially done), tell the user what's off
and ask whether to proceed, re-plan, or adjust.

### 3. Delegate to the implementer

Spawn the `implementer` subagent via the Agent tool
(`subagent_type: "implementer"`), passing the plan file path and issue number
in the prompt. Wait for its report.

### 4. Review the result

1. Surface the implementer's deviations and conflicts to the user verbatim
2. Review `git diff` against the plan: correctness, scope drift, convention violations
3. If something is wrong, send the implementer a follow-up (SendMessage) with
   the specific fix — don't fix it inline yourself unless it's trivial
4. When the diff is sound, show the manual testing checklist from the plan's
   Verification section

### 5. Tests

Only after the user confirms manual testing passed: delegate test-writing to
the same implementer agent (SendMessage follow-up), then review as in step 4.

## Notes

- The plan document is the implementer's **only context** — don't paraphrase
  it into the prompt, pass the file path
- The implementer never commits; use `/commit` from the main session when done
