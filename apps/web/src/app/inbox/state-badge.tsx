"use client";

import type { LifecycleState, TrackedItem } from "@skipper/shared";
import { useT } from "@/lib/app-i18n";

const STATE_CLASSES: Record<LifecycleState, string> = {
  triage: "bg-card text-muted border-border",
  queued: "bg-card text-muted border-border",
  closed: "bg-card text-muted border-border",
  planning: "bg-info-bg text-info border-info/25",
  coding: "bg-info-bg text-info border-info/25",
  "agent-review": "bg-info-bg text-info border-info/25",
  "plan-gate": "bg-signal-bg text-signal border-signal/25",
  "human-review": "bg-signal-bg text-signal border-signal/25",
  "needs-input": "bg-signal-bg text-signal border-signal/25",
  "changes-requested": "bg-signal-bg text-signal border-signal/25",
  "pr-open": "bg-success-bg text-success border-success/25",
  "in-review": "bg-success-bg text-success border-success/25",
  merged: "bg-merged-bg text-merged border-merged/25",
  failed: "bg-danger-bg text-danger border-danger/25",
  blocked: "bg-danger-bg text-danger border-danger/25",
};

function stateClasses(state: LifecycleState): string {
  return STATE_CLASSES[state];
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
