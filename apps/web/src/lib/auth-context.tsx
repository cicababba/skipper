"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { deriveProviderView } from "@nestbrain/shared";
import type { AuthState, ProviderAuthView } from "@nestbrain/shared";

interface AuthContextValue {
  /** Google view — what the current account UI renders. */
  state: ProviderAuthView;
  /** Full multi-provider state, for provider-aware UI. */
  authState: AuthState;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const DEFAULT_STATE: AuthState = { accounts: [], active: {}, flows: {} };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(DEFAULT_STATE);

  useEffect(() => {
    if (typeof window === "undefined" || !window.nestbrain) return;
    const auth = window.nestbrain.auth;
    let cancelled = false;

    auth.getState()
      .then((s) => { if (!cancelled) setAuthState(s); })
      .catch(() => { /* keep default */ });

    const off = auth.onStateChanged((s) => setAuthState(s));

    return () => { cancelled = true; off(); };
  }, []);

  const signIn = useCallback(async () => {
    if (!window.nestbrain) return;
    await window.nestbrain.auth.signIn("google");
  }, []);

  const signOut = useCallback(async () => {
    if (!window.nestbrain) return;
    await window.nestbrain.auth.signOut("google");
  }, []);

  const cancelSignIn = useCallback(async () => {
    if (!window.nestbrain) return;
    await window.nestbrain.auth.cancelSignIn("google");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state: deriveProviderView(authState, "google"),
      authState,
      signIn,
      signOut,
      cancelSignIn,
    }),
    [authState, signIn, signOut, cancelSignIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
