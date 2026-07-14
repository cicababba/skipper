"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { deriveProviderView } from "@skipper/shared";
import type { AuthProviderId, AuthState, ProviderAuthView } from "@skipper/shared";

interface AuthContextValue {
  /** Google view — what the current account UI renders. */
  state: ProviderAuthView;
  /** GitHub view — feeds the orchestrator connect UI (#15). */
  github: ProviderAuthView;
  /** Full multi-provider state, for provider-aware UI. */
  authState: AuthState;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signInProvider: (provider: AuthProviderId) => Promise<void>;
  signOutProvider: (provider: AuthProviderId) => Promise<void>;
  cancelSignInProvider: (provider: AuthProviderId) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const DEFAULT_STATE: AuthState = { accounts: [], active: {}, flows: {} };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(DEFAULT_STATE);

  useEffect(() => {
    if (typeof window === "undefined" || !window.skipper) return;
    const auth = window.skipper.auth;
    let cancelled = false;

    auth.getState()
      .then((s) => { if (!cancelled) setAuthState(s); })
      .catch(() => { /* keep default */ });

    const off = auth.onStateChanged((s) => setAuthState(s));

    return () => { cancelled = true; off(); };
  }, []);

  const signIn = useCallback(async () => {
    if (!window.skipper) return;
    await window.skipper.auth.signIn("google");
  }, []);

  const signOut = useCallback(async () => {
    if (!window.skipper) return;
    await window.skipper.auth.signOut("google");
  }, []);

  const cancelSignIn = useCallback(async () => {
    if (!window.skipper) return;
    await window.skipper.auth.cancelSignIn("google");
  }, []);

  const signInProvider = useCallback(async (provider: AuthProviderId) => {
    if (!window.skipper) return;
    await window.skipper.auth.signIn(provider);
  }, []);

  const signOutProvider = useCallback(async (provider: AuthProviderId) => {
    if (!window.skipper) return;
    await window.skipper.auth.signOut(provider);
  }, []);

  const cancelSignInProvider = useCallback(async (provider: AuthProviderId) => {
    if (!window.skipper) return;
    await window.skipper.auth.cancelSignIn(provider);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state: deriveProviderView(authState, "google"),
      github: deriveProviderView(authState, "github"),
      authState,
      signIn,
      signOut,
      cancelSignIn,
      signInProvider,
      signOutProvider,
      cancelSignInProvider,
    }),
    [authState, signIn, signOut, cancelSignIn, signInProvider, signOutProvider, cancelSignInProvider],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
