"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { deriveProviderAccounts, deriveProviderView } from "@skipper/shared";
import type {
  AuthProviderId,
  AuthProviderMeta,
  AuthState,
  ProviderAccountsView,
  ProviderAuthView,
} from "@skipper/shared";

interface AuthContextValue {
  /** Full multi-provider state, for provider-aware UI. */
  authState: AuthState;
  /** Registry-derived provider rows from the desktop; [] until the IPC answers. */
  providers: AuthProviderMeta[];
  /** True once the initial state + providers IPC round-trips settled — before
   *  this, an empty accounts list means "unknown", not "signed out". Stays
   *  false outside Electron, where there is no IPC to settle. */
  loaded: boolean;
  viewFor: (provider: AuthProviderId) => ProviderAuthView;
  accountsFor: (provider: AuthProviderId) => ProviderAccountsView;
  signIn: (provider: AuthProviderId, options?: { baseUrl?: string; clientId?: string }) => Promise<void>;
  signInWithPat: (
    provider: AuthProviderId,
    pat: string,
    options?: { baseUrl?: string },
  ) => Promise<void>;
  signOut: (provider: AuthProviderId, accountId: string) => Promise<void>;
  cancelSignIn: (provider: AuthProviderId) => Promise<void>;
  chooseResource: (provider: AuthProviderId, resourceId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const DEFAULT_STATE: AuthState = { accounts: [], flows: {} };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(DEFAULT_STATE);
  const [providers, setProviders] = useState<AuthProviderMeta[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.skipper) return;
    const auth = window.skipper.auth;
    let cancelled = false;

    const stateReady = auth.getState()
      .then((s) => { if (!cancelled) setAuthState(s); })
      .catch(() => { /* keep default */ });

    const providersReady = auth.getProviders()
      .then((p) => { if (!cancelled) setProviders(p); })
      .catch(() => { /* keep default */ });

    void Promise.all([stateReady, providersReady]).then(() => {
      if (!cancelled) setLoaded(true);
    });

    const off = auth.onStateChanged((s) => setAuthState(s));

    return () => { cancelled = true; off(); };
  }, []);

  const viewFor = useCallback(
    (provider: AuthProviderId) => deriveProviderView(authState, provider),
    [authState],
  );

  const accountsFor = useCallback(
    (provider: AuthProviderId) => deriveProviderAccounts(authState, provider),
    [authState],
  );

  const signIn = useCallback(async (provider: AuthProviderId, options?: { baseUrl?: string; clientId?: string }) => {
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

  const signOut = useCallback(async (provider: AuthProviderId, accountId: string) => {
    if (!window.skipper) return;
    await window.skipper.auth.signOut(provider, accountId);
  }, []);

  const cancelSignIn = useCallback(async (provider: AuthProviderId) => {
    if (!window.skipper) return;
    await window.skipper.auth.cancelSignIn(provider);
  }, []);

  const chooseResource = useCallback(async (provider: AuthProviderId, resourceId: string) => {
    if (!window.skipper) return;
    await window.skipper.auth.chooseResource(provider, resourceId);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      authState,
      providers,
      loaded,
      viewFor,
      accountsFor,
      signIn,
      signInWithPat,
      signOut,
      cancelSignIn,
      chooseResource,
    }),
    [authState, providers, loaded, viewFor, accountsFor, signIn, signInWithPat, signOut, cancelSignIn, chooseResource],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
