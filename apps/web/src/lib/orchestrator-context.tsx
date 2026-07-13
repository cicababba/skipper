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
  LifecycleState,
  OrchestratorState,
  OrchestratorTransitionResult,
} from "@nestbrain/shared";

interface OrchestratorContextValue {
  /** null = not loaded yet, or running outside Electron. */
  state: OrchestratorState | null;
  error: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    reason?: string,
  ) => Promise<OrchestratorTransitionResult>;
  openPr: (itemId: string) => Promise<OrchestratorTransitionResult>;
  clearError: () => void;
}

const OrchestratorContext = createContext<OrchestratorContextValue | null>(null);

export function OrchestratorProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OrchestratorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.nestbrain) return;
    const orchestrator = window.nestbrain.orchestrator;
    let cancelled = false;

    orchestrator
      .getState()
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });

    const off = orchestrator.onStateChanged((s) => setState(s));

    return () => { cancelled = true; off(); };
  }, []);

  const refresh = useCallback(async () => {
    if (!window.nestbrain) return;
    setRefreshing(true);
    try {
      setState(await window.nestbrain.orchestrator.refresh());
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
      if (!window.nestbrain) return { ok: false, error: "desktop only" };
      const result = await window.nestbrain.orchestrator.requestTransition(itemId, to, reason);
      if (!result.ok) setError(result.error);
      return result;
    },
    [],
  );

  const openPr = useCallback(async (itemId: string): Promise<OrchestratorTransitionResult> => {
    if (!window.nestbrain) return { ok: false, error: "desktop only" };
    const result = await window.nestbrain.orchestrator.openPr(itemId);
    if (!result.ok) setError(result.error);
    return result;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<OrchestratorContextValue>(
    () => ({ state, error, refreshing, refresh, requestTransition, openPr, clearError }),
    [state, error, refreshing, refresh, requestTransition, openPr, clearError],
  );

  return <OrchestratorContext.Provider value={value}>{children}</OrchestratorContext.Provider>;
}

export function useOrchestrator(): OrchestratorContextValue {
  const ctx = useContext(OrchestratorContext);
  if (!ctx) throw new Error("useOrchestrator must be used within OrchestratorProvider");
  return ctx;
}
