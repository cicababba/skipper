import type { LifecycleState } from "@nestbrain/shared";

const ACTIVE_STATES: readonly LifecycleState[] = [
  "triage",
  "planning",
  "plan-gate",
  "queued",
  "coding",
  "agent-review",
  "human-review",
  "pr-open",
  "in-review",
  "changes-requested",
];

export const TERMINAL_STATES: readonly LifecycleState[] = ["merged"];

export const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  triage: ["planning", "needs-input", "blocked", "closed"],
  planning: ["plan-gate", "queued", "needs-input", "failed", "blocked", "closed"],
  "plan-gate": ["queued", "planning", "needs-input", "blocked", "closed"],
  queued: ["coding", "needs-input", "blocked", "closed"],
  coding: ["agent-review", "needs-input", "failed", "blocked", "closed"],
  "agent-review": ["human-review", "coding", "needs-input", "failed", "closed"],
  "human-review": ["pr-open", "coding", "needs-input", "failed", "closed"],
  "pr-open": ["in-review", "merged", "changes-requested", "needs-input", "closed"],
  "in-review": ["merged", "changes-requested", "needs-input", "blocked", "closed"],
  "changes-requested": ["coding", "needs-input", "closed"],
  "needs-input": [...ACTIVE_STATES, "failed", "closed"],
  blocked: [...ACTIVE_STATES, "failed", "closed"],
  failed: ["triage", "closed"],
  merged: [],
  closed: ["triage"],
};

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return TRANSITIONS[from].includes(to);
}
