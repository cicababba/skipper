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
import type {
  AuthProviderId,
  AuthProviderMeta,
  AuthState,
  ProviderAuthView,
} from "@skipper/shared";

interface AuthContextValue {
  /** Full multi-provider state, for provider-aware UI. */
  authState: AuthState;
  /** Registry-derived provider rows from the desktop; [] until the IPC answers. */
  providers: AuthProviderMeta[];
  viewFor: (provider: AuthProviderId) => ProviderAuthView;
  signIn: (provider: AuthProviderId, options?: { baseUrl?: string }) => Promise<void>;
  signInWithPat: (
    provider: AuthProviderId,
    pat: string,
    options?: { baseUrl?: string },
  ) => Promise<void>;
  signOut: (provider: AuthProviderId) => Promise<void>;
  cancelSignIn: (provider: AuthProviderId) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const DEFAULT_STATE: AuthState = { accounts: [], active: {}, flows: {} };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(DEFAULT_STATE);
  const [providers, setProviders] = useState<AuthProviderMeta[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.skipper) return;
    const auth = window.skipper.auth;
    let cancelled = false;

    auth.getState()
      .then((s) => { if (!cancelled) setAuthState(s); })
      .catch(() => { /* keep default */ });

    auth.getProviders()
      .then((p) => { if (!cancelled) setProviders(p); })
      .catch(() => { /* keep default */ });

    const off = auth.onStateChanged((s) => setAuthState(s));

    return () => { cancelled = true; off(); };
  }, []);

  const viewFor = useCallback(
    (provider: AuthProviderId) => deriveProviderView(authState, provider),
    [authState],
  );

  const signIn = useCallback(async (provider: AuthProviderId, options?: { baseUrl?: string }) => {
    if (!window.skipper) return;
    await window.skipper.auth.signIn(provider, options);
  }, []);

  const signInWithPat = useCallback(
    async (provider: AuthProviderId, pat: string, options?: { baseUrl?: string }) => {
      if (!window.skipper) return;
      await window.skipper.auth.signInWithPat(provider, pat, options);
    },
    [],
  );

  const signOut = useCallback(async (provider: AuthProviderId) => {
    if (!window.skipper) return;
    await window.skipper.auth.signOut(provider);
  }, []);

  const cancelSignIn = useCallback(async (provider: AuthProviderId) => {
    if (!window.skipper) return;
    await window.skipper.auth.cancelSignIn(provider);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ authState, providers, viewFor, signIn, signInWithPat, signOut, cancelSignIn }),
    [authState, providers, viewFor, signIn, signInWithPat, signOut, cancelSignIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
