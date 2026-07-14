// Provider abstraction for the desktop OAuth flow. Each provider supplies a
// ProviderConfig; the generic flow in oauth-flow.ts consumes it.

import type { Account, AuthProviderId } from "@skipper/shared";

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
  authEndpoint: string;
  tokenEndpoint: string;
  /** Empty for GitHub Apps — permissions live on the App, no scope param. */
  scopes: string[];
  extraAuthParams?: Record<string, string>;
  clientId: string;
  /** Non-confidential desktop secret (same rationale as Google's Desktop-app secret). */
  clientSecret?: string;
  usesPkce: boolean;
  rotatesRefreshToken: boolean;
  requiresRefreshTokenOnExchange: boolean;
  /** Fixed loopback ports (GitHub: exact callback URL match). Unset → any free port. */
  redirectPorts?: readonly number[];
  mapUser(accessToken: string): Promise<Account>;
  /** Best-effort revocation on sign-out. */
  revoke?(tokens: ProviderTokens): Promise<void>;
}

export class OAuthError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OAuthError";
  }
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
