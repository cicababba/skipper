"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { TrackedItem, UntrackItemResult } from "@skipper/shared";
import { actionsFor, splitActions, type ItemAction } from "@/lib/inbox/actions";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT, type AppDict } from "@/lib/app-i18n";
import { ActionMenu } from "./action-menu";

// Renderer-side untrack confirm (#120): always prompt, then force-untrack (the
// backend's needsConfirm gate stays as a safety net). Returns whether it ran.
export async function confirmAndUntrack(
  item: TrackedItem,
  untrackItem: (itemId: string, force?: boolean) => Promise<UntrackItemResult>,
  t: AppDict,
): Promise<boolean> {
  if (!window.confirm(t.inbox.untrack.confirm(!!item.worktree, !!item.pr))) return false;
  const res = await untrackItem(item.id, true);
  return res.ok;
}

export function ItemActions({ item }: { item: TrackedItem }) {
  const { requestTransition, openPr, archiveItem, untrackItem, setPinned } = useOrchestrator();
  const { t } = useT();
  const [busyId, setBusyId] = useState<string | null>(null);

  const actions = actionsFor(item);
  if (actions.length === 0) return null;
  const { primary, menu, destructive } = splitActions(actions);
  // Exactly one spinner at a time: on the inline button when the primary runs, on the
  // kebab trigger otherwise (the menu is unmounted while an action is in flight).
  const busyInMenu = busyId !== null && busyId !== primary?.id;

  const run = async (action: ItemAction) => {
    setBusyId(action.id);
    try {
      if (action.kind === "openPr") await openPr(item.id);
      else if (action.kind === "pin") await setPinned(item.id, action.pinned);
      else if (action.kind === "archive") {
        const res = await archiveItem(item.id);
        if (!res.ok && res.needsConfirm && window.confirm(t.inbox.archive.confirmDirty(res.dirtyFiles)))
          await archiveItem(item.id, true);
      } else if (action.kind === "untrack") {
        await confirmAndUntrack(item, untrackItem, t);
      } else await requestTransition(item.id, action.to);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {primary && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void run(primary);
          }}
          disabled={busyId !== null}
          className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors disabled:opacity-50 whitespace-nowrap border-accent/30 bg-accent/10 text-accent hover:bg-accent/20"
        >
          {busyId === primary.id && <Loader2 size={11} className="animate-spin" />}
          {t.inbox.actions[primary.id]}
        </button>
      )}
      <ActionMenu
        actions={menu}
        destructive={destructive}
        busyId={busyId}
        busyInMenu={busyInMenu}
        onSelect={(action) => void run(action)}
      />
    </div>
  );
}
