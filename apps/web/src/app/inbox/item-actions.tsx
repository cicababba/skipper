"use client";

import { useState } from "react";
import type { TrackedItem, UntrackItemResult } from "@skipper/shared";
import { actionsFor, splitActions, type ItemAction } from "@/lib/inbox/actions";
import { useOrchestrator } from "@/lib/orchestrator-context";
import { useT, type AppDict } from "@/lib/app-i18n";
import { CloseItemDialog } from "@/components/close-item-dialog";
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
  const { requestTransition, openPr, archiveItem, untrackItem, closeItemOnTracker, setPinned, state } =
    useOrchestrator();
  const { t } = useT();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);

  const actions = actionsFor(item);
  if (actions.length === 0) return null;
  const { primary, menu, destructive } = splitActions(actions);
  // Every action lives in the kebab now (#193): the primary keeps its first-place
  // ordering, and the busy spinner always rides the trigger since nothing renders inline.
  const menuActions = primary ? [primary, ...menu] : menu;
  const busy = busyId !== null;
  const canCloseOnTracker = state?.sourceCapabilities[item.source]?.closeIssue ?? false;

  const run = async (action: ItemAction) => {
    if (action.kind === "closeDialog") {
      setCloseOpen(true);
      return;
    }
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
    <>
      <ActionMenu
        actions={menuActions}
        destructive={destructive}
        busyId={busyId}
        busyInMenu={busy}
        onSelect={(action) => void run(action)}
      />
      {closeOpen && (
        <CloseItemDialog
          item={item}
          canCloseOnTracker={canCloseOnTracker}
          onCloseOnTracker={async () => {
            const res = await closeItemOnTracker(item.id);
            if (res.ok) setCloseOpen(false);
            return res;
          }}
          onUntrack={async () => {
            const res = await untrackItem(item.id, true);
            if (res.ok) setCloseOpen(false);
            return res.ok;
          }}
          onOpenInTracker={() => void window.skipper?.openExternal(item.url)}
          onDismiss={() => setCloseOpen(false)}
        />
      )}
    </>
  );
}
