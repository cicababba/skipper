"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { StoredPlan } from "@skipper/shared";

// Per-tab chat wiring (#170): the item-detail shell owns the FAB/drawer and the
// per-interlocutor state; the Plan and Worktree tabs feed it through this
// context. A no-op default lets the bare <PlanDetailView/> fallback (item that
// never resolved) mount without a provider.

export type ChatKind = "plan" | "coder" | "reviewer";

export interface PlanDrawerHooks {
  /** The Plan tab exposes a chat only at the gate with a plan loaded. */
  available: boolean;
  /** Editing a section or running a gate action locks the plan chat out. */
  disabled: boolean;
  onPlanUpdated: (stored: StoredPlan) => void;
}

interface ItemChatContextValue {
  chatBusy: Record<ChatKind, boolean>;
  setChatBusy: (kind: ChatKind, busy: boolean) => void;
  planAvailable: boolean;
  planDisabled: boolean;
  registerPlanDrawer: (hooks: PlanDrawerHooks | null) => void;
  notifyPlanUpdated: (stored: StoredPlan) => void;
  worktreeSelection: string | null;
  setWorktreeSelection: (relPath: string | null) => void;
}

const IDLE_BUSY: Record<ChatKind, boolean> = { plan: false, coder: false, reviewer: false };

const ItemChatContext = createContext<ItemChatContextValue>({
  chatBusy: IDLE_BUSY,
  setChatBusy: () => {},
  planAvailable: false,
  planDisabled: false,
  registerPlanDrawer: () => {},
  notifyPlanUpdated: () => {},
  worktreeSelection: null,
  setWorktreeSelection: () => {},
});

export function useItemChat(): ItemChatContextValue {
  return useContext(ItemChatContext);
}

export function ItemChatProvider({ children }: { children: ReactNode }) {
  // onPlanUpdated changes identity every render of the Plan tab; keep it in a ref
  // so re-registration never re-renders. available/disabled are state — a change
  // there is a real drawer-visibility change the shell must react to.
  const planUpdatedRef = useRef<(stored: StoredPlan) => void>(() => {});
  const [planFlags, setPlanFlags] = useState({ available: false, disabled: false });
  const [worktreeSelection, setWorktreeSelectionState] = useState<string | null>(null);
  const [chatBusy, setChatBusyState] = useState<Record<ChatKind, boolean>>(IDLE_BUSY);

  const registerPlanDrawer = useCallback((hooks: PlanDrawerHooks | null) => {
    if (!hooks) {
      planUpdatedRef.current = () => {};
      setPlanFlags((f) => (f.available || f.disabled ? { available: false, disabled: false } : f));
      return;
    }
    planUpdatedRef.current = hooks.onPlanUpdated;
    setPlanFlags((f) =>
      f.available === hooks.available && f.disabled === hooks.disabled
        ? f
        : { available: hooks.available, disabled: hooks.disabled },
    );
  }, []);

  const notifyPlanUpdated = useCallback((stored: StoredPlan) => {
    planUpdatedRef.current(stored);
  }, []);

  const setWorktreeSelection = useCallback((relPath: string | null) => {
    setWorktreeSelectionState((cur) => (cur === relPath ? cur : relPath));
  }, []);

  const setChatBusy = useCallback((kind: ChatKind, busy: boolean) => {
    setChatBusyState((b) => (b[kind] === busy ? b : { ...b, [kind]: busy }));
  }, []);

  const value = useMemo<ItemChatContextValue>(
    () => ({
      chatBusy,
      setChatBusy,
      planAvailable: planFlags.available,
      planDisabled: planFlags.disabled,
      registerPlanDrawer,
      notifyPlanUpdated,
      worktreeSelection,
      setWorktreeSelection,
    }),
    [
      chatBusy,
      setChatBusy,
      planFlags,
      registerPlanDrawer,
      notifyPlanUpdated,
      worktreeSelection,
      setWorktreeSelection,
    ],
  );

  return <ItemChatContext.Provider value={value}>{children}</ItemChatContext.Provider>;
}
