import type { LifecycleState, TrackedItem } from "@skipper/shared";
import { actionsFor, type ItemAction } from "./actions";

// Overview "Now" rail (#169): the status sentence + primary action, derived
// purely from the item's current state. No transition logic of its own — the
// resume action reuses actionsFor.

export type NowSentence =
  | { kind: "waiting-you" }
  | { kind: "role-working"; role: "planner" | "coder" | "reviewer"; sinceMs: number }
  | { kind: "queued"; pinned: boolean }
  | { kind: "parked"; state: "needs-input" | "blocked" | "failed"; reason?: string }
  | { kind: "upstream"; state: "pr-open" | "in-review" | "changes-requested" }
  | { kind: "settled"; state: "merged" | "closed" };

export function nowSentence(item: TrackedItem, now: number): NowSentence {
  const enteredMs = Date.parse(item.transitions.at(-1)?.at ?? item.updatedAt);
  const sinceMs = Number.isNaN(enteredMs) ? 0 : Math.max(0, now - enteredMs);
  const reason = item.transitions.at(-1)?.reason;
  switch (item.state) {
    case "triage":
    case "plan-gate":
    case "human-review":
      return { kind: "waiting-you" };
    case "planning":
      return { kind: "role-working", role: "planner", sinceMs };
    case "coding":
      return { kind: "role-working", role: "coder", sinceMs };
    case "agent-review":
      return { kind: "role-working", role: "reviewer", sinceMs };
    case "queued":
      return { kind: "queued", pinned: item.pinned === true };
    case "needs-input":
    case "blocked":
    case "failed":
      return { kind: "parked", state: item.state, reason };
    case "pr-open":
    case "in-review":
    case "changes-requested":
      return { kind: "upstream", state: item.state };
    case "merged":
    case "closed":
      return { kind: "settled", state: item.state };
  }
}

export type RailPrimary =
  | { kind: "action"; action: ItemAction }
  | { kind: "resume-session"; sessionId?: string }
  | { kind: "plan-link" }
  | null;

function parkingSessionId(item: TrackedItem): string | undefined {
  const phase: LifecycleState | undefined = item.resumeTo ?? item.transitions.at(-1)?.from ?? undefined;
  switch (phase) {
    case "coding":
      return item.worktree?.sessionId;
    case "agent-review":
      return item.review?.sessionId;
    case "planning":
      return item.plan?.sessionId;
    default:
      return undefined;
  }
}

export function railPrimary(item: TrackedItem): RailPrimary {
  switch (item.state) {
    case "human-review": {
      const openPr = actionsFor(item).find((a) => a.id === "openPr");
      return openPr ? { kind: "action", action: openPr } : null;
    }
    case "failed":
    case "needs-input":
    case "blocked":
      return { kind: "resume-session", sessionId: parkingSessionId(item) };
    case "plan-gate":
      return { kind: "plan-link" };
    default:
      return null;
  }
}
