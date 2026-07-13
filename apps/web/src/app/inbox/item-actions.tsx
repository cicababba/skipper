"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { TrackedItem } from "@nestbrain/shared";
import { actionsFor, type ItemAction } from "@/lib/inbox/actions";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT } from "@/lib/app-i18n";

export function ItemActions({ item }: { item: TrackedItem }) {
  const { requestTransition, openPr } = useOrchestrator();
  const { t } = useT();
  const [busyId, setBusyId] = useState<string | null>(null);

  const actions = actionsFor(item);
  if (actions.length === 0) return null;

  const run = async (action: ItemAction) => {
    setBusyId(action.id);
    try {
      if (action.kind === "openPr") await openPr(item.id);
      else await requestTransition(item.id, action.to);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {actions.map((action, i) => (
        <button
          key={action.id}
          onClick={(e) => {
            e.stopPropagation();
            void run(action);
          }}
          disabled={busyId !== null}
          className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors disabled:opacity-50 whitespace-nowrap ${
            i === 0 && action.id !== "close"
              ? "border-accent/30 bg-accent/10 text-accent hover:bg-accent/20"
              : "border-border text-muted hover:text-foreground hover:bg-card-hover"
          }`}
        >
          {busyId === action.id && <Loader2 size={11} className="animate-spin" />}
          {t.inbox.actions[action.id]}
        </button>
      ))}
    </div>
  );
}
