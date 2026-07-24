// Provider abstraction for the desktop OAuth flow. Each provider supplies a
// ProviderConfig; the generic flow in oauth-flow.ts consumes it.

import type { Account, AuthProviderId, ResourceCandidate } from "@skipper/shared";

/** A provider maps an identity without the store key — AuthManager stamps `key`
 *  from (provider, id, baseUrl) on write (#101). */
export type MappedAccount = Omit<Account, "key">;

export interface ProviderTokens {
  accessToken: string;
  refreshToken: string;
  /** Google only — proof of email for the supporter entitlement. */
  idToken?: string;
  expiresAt: number; // ms epoch
  /** GitHub only — refresh tokens expire too (~6 months). */
  refreshTokenExpiresAt?: number; // ms epoch
  scope: string;
  tokenType: string;
}

export interface RefreshedTokens {
  accessToken: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
  idToken?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
}

export interface ProviderConfig {
  id: AuthProviderId;
  displayName: string;
  /** Fixed-host providers ignore the argument (self-hosted instances pass their base URL). */
  authEndpoint(baseUrl?: string): string;
  tokenEndpoint(baseUrl?: string): string;
  /** Empty for GitHub Apps — permissions live on the App, no scope param. */
  scopes: string[];
  extraAuthParams?: Record<string, string>;
  clientId: string;
  /** Non-confidential desktop secret (same rationale as Google's Desktop-app secret). */
  clientSecret?: string;
  usesPkce: boolean;
  rotatesRefreshToken: boolean;
  requiresRefreshTokenOnExchange: boolean;
  /** Token endpoint body encoding. Default "form" (x-www-form-urlencoded);
   *  Atlassian requires a JSON body on both grants. */
  tokenRequestFormat?: "form" | "json";
  /** Token endpoint client authentication. Default: credentials in the body.
   *  "basic" sends Authorization: Basic base64(clientId:clientSecret) and
   *  omits both from the body (Bitbucket documents only Basic). */
  tokenAuth?: "basic";
  /** Fixed loopback ports (GitHub: exact callback URL match). Unset → any free port. */
  redirectPorts?: readonly number[];
  /** Connect flow must collect an instance URL before auth (self-hosted providers). */
  requiresBaseUrl: boolean;
  /** OAuth is fixed-host, but the PAT fallback still needs an instance URL
   *  (Jira Data Center). */
  patRequiresBaseUrl?: boolean;
  /** Tracker whose projects have no inherent repo — Settings shows the
   *  project→repo mapping editor for its accounts (#79). */
  needsProjectMapping?: boolean;
  /** Prefill for the instance-URL field (the provider's public host). */
  defaultBaseUrl?: string;
  /** Personal-access-token sign-in fallback (no refresh, no expiry). */
  supportsPat: boolean;
  /** Resolve the sites this OAuth token can reach — the manager picks one (or
   *  asks the user) before mapUser. Absent = the token maps directly. */
  listResources?(accessToken: string): Promise<ResourceCandidate[]>;
  mapUser(accessToken: string, baseUrl?: string, resource?: ResourceCandidate): Promise<MappedAccount>;
  /** Required when supportsPat: validate the PAT and map the identity. */
  mapUserFromPat?(token: string, baseUrl?: string): Promise<MappedAccount>;
  /** Best-effort revocation on sign-out. */
  revoke?(tokens: ProviderTokens, baseUrl?: string): Promise<void>;
}

export class OAuthError extends Error {
  /** HTTP status of the token-endpoint response, when the failure came from one. */
  readonly status?: number;
  /** OAuth2 `error` code (e.g. "invalid_grant"), when the response carried one. */
  readonly oauthCode?: string;

  constructor(
    message: string,
    public readonly cause?: unknown,
    meta?: { status?: number; oauthCode?: string },
  ) {
    super(message);
    this.name = "OAuthError";
    this.status = meta?.status;
    this.oauthCode = meta?.oauthCode;
  }
}

/**
 * A refresh failure is a definitive grant revocation — the account must
 * re-authenticate — only for an invalid_grant, which RFC 6749 returns as HTTP
 * 400. Network errors (no status), 5xx, and 429 are transient: the account
 * stays and the next poll retries.
 */
export function isRefreshRevocation(err: unknown): boolean {
  if (!(err instanceof OAuthError)) return false;
  return err.oauthCode === "invalid_grant" || err.status === 400;
}

export function applyRefreshedTokens(
  current: ProviderTokens,
  refreshed: RefreshedTokens,
  rotates: boolean,
): ProviderTokens {
  const next: ProviderTokens = {
    ...current,
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
    scope: refreshed.scope ?? current.scope,
    tokenType: refreshed.tokenType ?? current.tokenType,
    idToken: refreshed.idToken ?? current.idToken,
  };
  if (rotates && refreshed.refreshToken) {
    next.refreshToken = refreshed.refreshToken;
    next.refreshTokenExpiresAt = refreshed.refreshTokenExpiresAt ?? current.refreshTokenExpiresAt;
  }
  return next;
}
