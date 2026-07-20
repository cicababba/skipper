"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  ArchiveItemResult,
  LifecycleState,
  OrchestratorSettings,
  OrchestratorState,
  OrchestratorTransitionResult,
  ResumeRiteAction,
  UntrackItemResult,
} from "@skipper/shared";

interface OrchestratorContextValue {
  /** null = not loaded yet, or running outside Electron. */
  state: OrchestratorState | null;
  error: string | null;
  refreshing: boolean;
  refresh: (full?: boolean) => Promise<void>;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    reason?: string,
  ) => Promise<OrchestratorTransitionResult>;
  openPr: (itemId: string) => Promise<OrchestratorTransitionResult>;
  archiveItem: (itemId: string, force?: boolean) => Promise<ArchiveItemResult>;
  untrackItem: (itemId: string, force?: boolean) => Promise<UntrackItemResult>;
  setIntakePaused: (paused: boolean) => Promise<void>;
  /** Global settings writer (#62); the handler validates each key. */
  updateSettings: (patch: Partial<OrchestratorSettings>) => Promise<void>;
  resolveResumeRite: (action: ResumeRiteAction, itemIds?: string[]) => Promise<void>;
  setPinned: (itemId: string, pinned: boolean) => Promise<OrchestratorTransitionResult>;
  clearError: () => void;
}

const OrchestratorContext = createContext<OrchestratorContextValue | null>(null);

export function OrchestratorProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OrchestratorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.skipper) return;
    const orchestrator = window.skipper.orchestrator;
    let cancelled = false;

    orchestrator
      .getState()
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });

    const off = orchestrator.onStateChanged((s) => setState(s));

    return () => { cancelled = true; off(); };
  }, []);

  const refresh = useCallback(async (full?: boolean) => {
    if (!window.skipper) return;
    setRefreshing(true);
    try {
      setState(await window.skipper.orchestrator.refresh(full));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const requestTransition = useCallback(
    async (
      itemId: string,
      to: LifecycleState,
      reason?: string,
    ): Promise<OrchestratorTransitionResult> => {
      if (!window.skipper) return { ok: false, error: "desktop only" };
      const result = await window.skipper.orchestrator.requestTransition(itemId, to, reason);
      if (!result.ok) setError(result.error);
      return result;
    },
    [],
  );

  const openPr = useCallback(async (itemId: string): Promise<OrchestratorTransitionResult> => {
    if (!window.skipper) return { ok: false, error: "desktop only" };
    const result = await window.skipper.orchestrator.openPr(itemId);
    if (!result.ok) setError(result.error);
    return result;
  }, []);

  const archiveItem = useCallback(
    async (itemId: string, force?: boolean): Promise<ArchiveItemResult> => {
      if (!window.skipper) return { ok: false, error: "desktop only" };
      const result = await window.skipper.orchestrator.archiveItem(itemId, force);
      // needsConfirm is the dirty-worktree prompt, not an error — the caller drives it.
      if (!result.ok && !result.needsConfirm) setError(result.error);
      return result;
    },
    [],
  );

  const untrackItem = useCallback(
    async (itemId: string, force?: boolean): Promise<UntrackItemResult> => {
      if (!window.skipper) return { ok: false, error: "desktop only" };
      const result = await window.skipper.orchestrator.untrackItem(itemId, force);
      // needsConfirm is the worktree/PR prompt, not an error — the caller drives it.
      if (!result.ok && !result.needsConfirm) setError(result.error);
      return result;
    },
    [],
  );

  const setIntakePaused = useCallback(async (paused: boolean) => {
    if (!window.skipper) return;
    try {
      setState(await window.skipper.orchestrator.setIntakePaused(paused));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const updateSettings = useCallback(async (patch: Partial<OrchestratorSettings>) => {
    if (!window.skipper) return;
    try {
      setState(await window.skipper.orchestrator.updateSettings(patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const resolveResumeRite = useCallback(
    async (action: ResumeRiteAction, itemIds?: string[]) => {
      if (!window.skipper) return;
      try {
        setState(await window.skipper.orchestrator.resolveResumeRite(action, itemIds));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const setPinned = useCallback(
    async (itemId: string, pinned: boolean): Promise<OrchestratorTransitionResult> => {
      if (!window.skipper) return { ok: false, error: "desktop only" };
      const result = await window.skipper.orchestrator.setPinned(itemId, pinned);
      if (!result.ok) setError(result.error);
      return result;
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<OrchestratorContextValue>(
    () => ({
      state,
      error,
      refreshing,
      refresh,
      requestTransition,
      openPr,
      archiveItem,
      untrackItem,
      setIntakePaused,
      updateSettings,
      resolveResumeRite,
      setPinned,
      clearError,
    }),
    [
      state,
      error,
      refreshing,
      refresh,
      requestTransition,
      openPr,
      archiveItem,
      untrackItem,
      setIntakePaused,
      updateSettings,
      resolveResumeRite,
      setPinned,
      clearError,
    ],
  );

  return <OrchestratorContext.Provider value={value}>{children}</OrchestratorContext.Provider>;
}

export function useOrchestrator(): OrchestratorContextValue {
  const ctx = useContext(OrchestratorContext);
  if (!ctx) throw new Error("useOrchestrator must be used within OrchestratorProvider");
  return ctx;
}
