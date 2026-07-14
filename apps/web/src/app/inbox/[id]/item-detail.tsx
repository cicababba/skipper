"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";
import { PlanDetailView } from "./plan-detail";
import { ReviewDetailView } from "./review-detail";
import { WorktreeDetailView } from "./worktree-detail";

// Latches the view once when the item first resolves, so a background state
// change never swaps the screen out from under the user mid-edit.
export function ItemDetailView() {
  const params = useParams();
  const id = decodeURIComponent(String(params.id));
  const { state } = useOrchestrator();
  const { t } = useT();

  const [mode, setMode] = useState<"plan" | "review" | null>(null);
  const [tab, setTab] = useState<"details" | "worktree">("details");
  const item = state?.items.find((i) => i.id === id);

  // Adjust-state-during-render latch: set once when the item first resolves.
  if (mode === null && item) setMode(item.state === "human-review" ? "review" : "plan");

  const detailsView = mode === "review" ? <ReviewDetailView /> : <PlanDetailView />;

  // Worktree control center (#40): only reachable while the item has a
  // worktree recorded. Without one the latched view renders as before.
  if (!item?.worktree) return detailsView;

  const tabs = [
    { key: "details" as const, label: t.inbox.worktree.detailsTab },
    { key: "worktree" as const, label: t.inbox.worktree.worktreeTab },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-6 pt-3 border-b border-border shrink-0">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 text-[12px] font-medium rounded-t-md border-b-2 transition-colors ${
              tab === key
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex flex-col">
        {tab === "worktree" ? <WorktreeDetailView /> : detailsView}
      </div>
    </div>
  );
}
