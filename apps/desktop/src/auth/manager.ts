// AuthManager — single source of truth for connected accounts in the main
// process. Owns the OAuth flows, the persisted multi-account store, in-memory
// state, and broadcasts state changes to subscribers (typically the renderer).

import {
  AUTH_PROVIDER_IDS,
  normalizeBaseUrl,
  type Account,
  type AuthProviderId,
  type AuthState,
} from "@skipper/shared";
import { OAuthError, applyRefreshedTokens, type ProviderConfig, type ProviderTokens } from "./provider";
import { runOAuthFlow, refreshTokens } from "./oauth-flow";
import { PROVIDERS } from "./providers";
import { accountKey, emptyStore, type AuthStoreFile, type StoredAccount } from "./store-format";
import { loadStore, saveStore, clearStore, isEncryptionAvailable } from "./token-store";

// Source builds get placeholder OAuth credentials (ensure-oauth-config.mjs):
// sign-in would only fail at the provider with invalid_client, so surface a
// clear per-provider "unconfigured" state and the UI shows a disabled control.
function isConfigured(config: ProviderConfig): boolean {
  return !!config.clientId && !config.clientId.startsWith("YOUR_");
}

// Refresh the access token this many ms before it actually expires.
const REFRESH_LEAD_MS = 5 * 60 * 1000; // 5 minutes

type Listener = (state: AuthState) => void;

export class AuthManager {
  private store: AuthStoreFile = emptyStore();
  private flows: AuthState["flows"] = {};
  private listeners = new Set<Listener>();
  private signInAborts = new Map<AuthProviderId, AbortController>();

  constructor(private readonly providers: Record<AuthProviderId, ProviderConfig> = PROVIDERS) {
    for (const id of AUTH_PROVIDER_IDS) {
      if (!isConfigured(this.providers[id])) {
        this.flows[id] = { status: "unconfigured" };
      }
    }
  }

  /** Load any previously persisted accounts. Call once on app startup. */
  async init(): Promise<void> {
    if (AUTH_PROVIDER_IDS.every((id) => this.flows[id]?.status === "unconfigured")) return;
    if (!isEncryptionAvailable()) {
      console.warn("[auth] safeStorage unavailable on this platform");
    }
    const store = await loadStore();
    if (store) {
      this.store = store;
      this.emit();
    }
  }

  getState(): AuthState {
    return {
      // The store key IS the account key — derive it here so legacy auth.enc
      // accounts (persisted without `key`) still carry one in memory (#101).
      accounts: Object.entries(this.store.accounts).map(([key, a]) => ({
        ...a.account,
        key,
        signedInAt: a.signedInAt,
      })),
      flows: { ...this.flows },
    };
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Cancel any in-flight sign-in (e.g. user closed the browser tab). */
  cancelSignIn(provider: AuthProviderId): void {
    this.signInAborts.get(provider)?.abort();
    this.signInAborts.delete(provider);
  }

  async signIn(provider: AuthProviderId, options?: { baseUrl?: string }): Promise<void> {
    const config = this.providers[provider];
    if (!isConfigured(config)) return; // source build — nothing to sign in to
    if (this.flows[provider]?.status === "signing-in") {
      // Already running — ignore double-clicks.
      return;
    }
    const baseUrl = this.resolveBaseUrl(config, options);
    if (baseUrl === null) return;
    this.setFlow(provider, { status: "signing-in" });
    const abort = new AbortController();
    this.signInAborts.set(provider, abort);
    try {
      const { tokens, account: mapped } = await runOAuthFlow(config, abort.signal, baseUrl);
      const account: Omit<Account, "key"> = {
        ...mapped,
        authMethod: "oauth",
        ...(baseUrl ? { baseUrl } : {}),
      };
      await this.storeAccount(provider, account, tokens, baseUrl);
      this.setFlow(provider, { status: "idle" });
    } catch (err) {
      this.failFlow(provider, err);
    } finally {
      this.signInAborts.delete(provider);
    }
  }

  /**
   * Sign in with a personal access token instead of OAuth — the fallback for
   * self-hosted instances where the user can't register an OAuth app. No
   * refresh, no expiry, no browser roundtrip (cancelSignIn stays OAuth-only).
   * Works without OAuth client credentials, so no isConfigured guard.
   */
  async signInWithPat(
    provider: AuthProviderId,
    pat: string,
    options?: { baseUrl?: string },
  ): Promise<void> {
    const config = this.providers[provider];
    if (!config.supportsPat || !config.mapUserFromPat) return;
    if (this.flows[provider]?.status === "signing-in") return;
    if (!pat.trim()) {
      this.failFlow(provider, new OAuthError("A personal access token is required"));
      return;
    }
    const baseUrl = this.resolveBaseUrl(config, options);
    if (baseUrl === null) return;
    this.setFlow(provider, { status: "signing-in" });
    try {
      const mapped = await config.mapUserFromPat(pat.trim(), baseUrl);
      const account: Omit<Account, "key"> = {
        ...mapped,
        authMethod: "pat",
        ...(baseUrl ? { baseUrl } : {}),
      };
      const tokens: ProviderTokens = {
        accessToken: pat.trim(),
        refreshToken: "",
        expiresAt: Number.MAX_SAFE_INTEGER,
        scope: "",
        tokenType: "pat",
      };
      await this.storeAccount(provider, account, tokens, baseUrl);
      this.setFlow(provider, { status: "idle" });
    } catch (err) {
      this.failFlow(provider, err);
    }
  }

  /** Normalized baseUrl to use, undefined when none given, null = invalid (flow errored). */
  private resolveBaseUrl(
    config: ProviderConfig,
    options?: { baseUrl?: string },
  ): string | undefined | null {
    const normalized = options?.baseUrl ? normalizeBaseUrl(options.baseUrl) : undefined;
    if (config.requiresBaseUrl && !normalized) {
      this.failFlow(config.id, new OAuthError("A valid instance URL is required"));
      return null;
    }
    return normalized ?? undefined;
  }

  private async storeAccount(
    provider: AuthProviderId,
    account: Omit<Account, "key">,
    tokens: ProviderTokens,
    baseUrl?: string,
  ): Promise<void> {
    const key = accountKey(provider, account.id, baseUrl);
    this.store.accounts[key] = { account: { ...account, key }, tokens, signedInAt: Date.now() };
    await saveStore(this.store);
  }

  private failFlow(provider: AuthProviderId, err: unknown): void {
    const message = err instanceof OAuthError ? err.message : String(err);
    console.error(`[auth] ${provider} sign-in failed:`, err);
    this.setFlow(provider, { status: "error", error: message });
    // Settle back to idle so the UI can offer a retry.
    setTimeout(() => {
      if (this.flows[provider]?.status === "error") this.setFlow(provider, { status: "idle" });
    }, 4000);
  }

  async signOut(key: string): Promise<void> {
    const stored = this.store.accounts[key];
    if (stored) delete this.store.accounts[key];
    await this.persist();
    if (stored && stored.account.authMethod !== "pat") {
      // Best-effort: revoke at the provider so the tokens can't be reused.
      // PATs are user-created — never destroy them on the user's behalf.
      void this.providers[stored.account.provider].revoke?.(stored.tokens, stored.account.baseUrl);
    }
    this.emit();
  }

  /**
   * Return a valid access token for the account with this key, refreshing if
   * necessary. Returns null if no such account.
   *
   * `forceRefresh` skips the cached-token fast path — used when the provider
   * API itself reports 401 (e.g. the user revoked access).
   */
  async getAccessToken(key: string, forceRefresh = false): Promise<string | null> {
    const stored = this.store.accounts[key];
    if (!stored) return null;
    // A PAT has no refresh path — hand it back even on forceRefresh; a revoked
    // one surfaces as API errors until the user signs the account out.
    if (stored.account.authMethod === "pat") return stored.tokens.accessToken;
    if (!forceRefresh && stored.tokens.expiresAt - REFRESH_LEAD_MS > Date.now()) {
      return stored.tokens.accessToken;
    }
    const provider = stored.account.provider;
    const config = this.providers[provider];
    try {
      const refreshed = await refreshTokens(config, stored.tokens.refreshToken, stored.account.baseUrl);
      const next = applyRefreshedTokens(stored.tokens, refreshed, config.rotatesRefreshToken);
      this.store.accounts[key] = { ...stored, tokens: next };
      // Persist immediately: losing a rotated refresh token kills the grant.
      await saveStore(this.store);
      return next.accessToken;
    } catch (err) {
      console.error(`[auth] ${provider} refresh failed, dropping account:`, err);
      // Refresh token revoked / expired — the account must re-authenticate.
      await this.signOut(key);
      return null;
    }
  }

  /**
   * Fresh Google id_token (proof of the signed-in email) for the update
   * entitlement exchange. Intentionally Google-pinned: the licensing service
   * only exposes the Google-specific /entitlement/google endpoint. id_tokens
   * share the access token's ~1h lifetime, so reuse the refresh path to get a
   * current one.
   */
  async getGoogleIdToken(): Promise<string | null> {
    let bestKey: string | undefined;
    let best: StoredAccount | undefined;
    for (const [key, stored] of Object.entries(this.store.accounts)) {
      if (stored.account.provider !== "google") continue;
      if (!best || stored.signedInAt >= best.signedInAt) {
        best = stored;
        bestKey = key;
      }
    }
    if (!best || !bestKey) return null;
    if (best.tokens.expiresAt - REFRESH_LEAD_MS > Date.now()) {
      return best.tokens.idToken ?? null;
    }
    await this.getAccessToken(bestKey, true);
    return this.store.accounts[bestKey]?.tokens.idToken ?? null;
  }

  private async persist(): Promise<void> {
    const hasAccounts = Object.keys(this.store.accounts).length > 0;
    if (hasAccounts) await saveStore(this.store);
    else await clearStore();
  }

  private setFlow(provider: AuthProviderId, flow: NonNullable<AuthState["flows"][AuthProviderId]>): void {
    if (flow.status === "idle") delete this.flows[provider];
    else this.flows[provider] = flow;
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    for (const cb of this.listeners) {
      try { cb(state); } catch (err) { console.error("[auth] listener threw:", err); }
    }
  }
}
