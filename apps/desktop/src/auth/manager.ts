// AuthManager — single source of truth for connected accounts in the main
// process. Owns the OAuth flows, the persisted multi-account store, in-memory
// state, and broadcasts state changes to subscribers (typically the renderer).

import { AUTH_PROVIDER_IDS, type AuthProviderId, type AuthState } from "@skipper/shared";
import { OAuthError, applyRefreshedTokens, type ProviderConfig } from "./provider";
import { runOAuthFlow, refreshTokens } from "./oauth-flow";
import { PROVIDERS } from "./providers";
import { accountKey, emptyStore, type AuthStoreFile } from "./store-format";
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

  constructor() {
    for (const id of AUTH_PROVIDER_IDS) {
      if (!isConfigured(PROVIDERS[id])) {
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
      accounts: Object.values(this.store.accounts).map((a) => a.account),
      active: { ...this.store.active },
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

  async signIn(provider: AuthProviderId): Promise<void> {
    const config = PROVIDERS[provider];
    if (!isConfigured(config)) return; // source build — nothing to sign in to
    if (this.flows[provider]?.status === "signing-in") {
      // Already running — ignore double-clicks.
      return;
    }
    this.setFlow(provider, { status: "signing-in" });
    const abort = new AbortController();
    this.signInAborts.set(provider, abort);
    try {
      const { tokens, account } = await runOAuthFlow(config, abort.signal);
      const key = accountKey(provider, account.id);
      this.store.accounts[key] = { account, tokens, signedInAt: Date.now() };
      this.store.active[provider] = account.id;
      await saveStore(this.store);
      this.setFlow(provider, { status: "idle" });
    } catch (err) {
      const message = err instanceof OAuthError ? err.message : String(err);
      console.error(`[auth] ${provider} sign-in failed:`, err);
      this.setFlow(provider, { status: "error", error: message });
      // Settle back to idle so the UI can offer a retry.
      setTimeout(() => {
        if (this.flows[provider]?.status === "error") this.setFlow(provider, { status: "idle" });
      }, 4000);
    } finally {
      this.signInAborts.delete(provider);
    }
  }

  async signOut(provider: AuthProviderId, accountId?: string): Promise<void> {
    const id = accountId ?? this.store.active[provider];
    if (!id) return;
    const key = accountKey(provider, id);
    const stored = this.store.accounts[key];
    delete this.store.accounts[key];
    if (this.store.active[provider] === id) {
      const remaining = Object.values(this.store.accounts).find((a) => a.account.provider === provider);
      if (remaining) this.store.active[provider] = remaining.account.id;
      else delete this.store.active[provider];
    }
    await this.persist();
    if (stored) {
      // Best-effort: revoke at the provider so the tokens can't be reused.
      void PROVIDERS[provider].revoke?.(stored.tokens);
    }
    this.emit();
  }

  async setActiveAccount(provider: AuthProviderId, accountId: string): Promise<void> {
    if (!this.store.accounts[accountKey(provider, accountId)]) return;
    this.store.active[provider] = accountId;
    await this.persist();
    this.emit();
  }

  /**
   * Return a valid access token for an account (default: the provider's
   * active one), refreshing if necessary. Returns null if no such account.
   *
   * `forceRefresh` skips the cached-token fast path — used when the provider
   * API itself reports 401 (e.g. the user revoked access).
   */
  async getAccessToken(
    provider: AuthProviderId,
    accountId?: string,
    forceRefresh = false,
  ): Promise<string | null> {
    const id = accountId ?? this.store.active[provider];
    if (!id) return null;
    const key = accountKey(provider, id);
    const stored = this.store.accounts[key];
    if (!stored) return null;
    if (!forceRefresh && stored.tokens.expiresAt - REFRESH_LEAD_MS > Date.now()) {
      return stored.tokens.accessToken;
    }
    const config = PROVIDERS[provider];
    try {
      const refreshed = await refreshTokens(config, stored.tokens.refreshToken);
      const next = applyRefreshedTokens(stored.tokens, refreshed, config.rotatesRefreshToken);
      this.store.accounts[key] = { ...stored, tokens: next };
      // Persist immediately: losing a rotated refresh token kills the grant.
      await saveStore(this.store);
      return next.accessToken;
    } catch (err) {
      console.error(`[auth] ${provider} refresh failed, dropping account:`, err);
      // Refresh token revoked / expired — the account must re-authenticate.
      await this.signOut(provider, id);
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
    const id = this.store.active.google;
    if (!id) return null;
    const stored = this.store.accounts[accountKey("google", id)];
    if (!stored) return null;
    if (stored.tokens.expiresAt - REFRESH_LEAD_MS > Date.now()) {
      return stored.tokens.idToken ?? null;
    }
    await this.getAccessToken("google", id, true);
    return this.store.accounts[accountKey("google", id)]?.tokens.idToken ?? null;
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
