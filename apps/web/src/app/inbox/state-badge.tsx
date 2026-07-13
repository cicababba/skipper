"use client";

import type { LifecycleState, TrackedItem } from "@nestbrain/shared";
import { useT } from "@/lib/app-i18n";

function stateClasses(state: LifecycleState): string {
  switch (state) {
    case "failed":
      return "bg-red-500/10 text-red-300 border-red-500/20";
    case "needs-input":
    case "blocked":
      return "bg-amber-500/10 text-amber-300 border-amber-500/20";
    case "plan-gate":
    case "human-review":
      return "bg-accent/15 text-accent border-accent/30";
    case "merged":
      return "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
    case "closed":
      return "bg-card text-muted border-border";
    default:
      return "bg-accent/10 text-accent/90 border-accent/20";
  }
}

export function StateBadge({ item }: { item: TrackedItem }) {
  const { t } = useT();
  const lastReason = item.transitions.at(-1)?.reason;
  return (
    <span
      className={`inline-block text-[11px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap ${stateClasses(item.state)}`}
      title={lastReason}
    >
      {t.inbox.states[item.state]}
    </span>
  );
}
