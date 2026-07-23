import type { LifecycleState, OrchestratorAccountState, TrackedItem } from "@skipper/shared";
import { ATTENTION_STATES } from "./model";

// Longest-standing severity first when the attention list is capped.
const SEVERITY: Record<string, number> = {
  failed: 0,
  blocked: 1,
  "needs-input": 2,
  "plan-gate": 3,
  "human-review": 4,
};

export function attentionItems(
  items: TrackedItem[],
  cap = 5,
): { shown: TrackedItem[]; overflow: number } {
  const matched = items
    .filter((it) => ATTENTION_STATES.includes(it.state))
    .sort((a, b) => {
      const sa = SEVERITY[a.state] ?? 99;
      const sb = SEVERITY[b.state] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.updatedAt.localeCompare(b.updatedAt);
    });
  const shown = matched.slice(0, cap);
  return { shown, overflow: matched.length - shown.length };
}

export function attentionTone(state: LifecycleState): "danger" | "signal" | "accent" {
  if (state === "failed") return "danger";
  if (state === "needs-input" || state === "blocked") return "signal";
  return "accent";
}

export function accountsSummary(accounts: Record<string, OrchestratorAccountState>): {
  total: number;
  errors: number;
  lastSyncAt?: number;
} {
  const values = Object.values(accounts);
  let errors = 0;
  let lastSyncAt: number | undefined;
  for (const a of values) {
    if (a.status === "error" || a.status === "auth-error") errors += 1;
    if (a.lastSyncAt !== undefined) {
      lastSyncAt = lastSyncAt === undefined ? a.lastSyncAt : Math.max(lastSyncAt, a.lastSyncAt);
    }
  }
  return { total: values.length, errors, lastSyncAt };
}
