import { GOOGLE_OAUTH_ENDPOINTS, type Account } from "@skipper/shared";
import { OAuthError, type ProviderConfig, type ProviderTokens } from "../provider";
import { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET } from "../oauth-config";

interface GoogleUserinfo {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

async function mapUser(accessToken: string): Promise<Account> {
  const res = await fetch(GOOGLE_OAUTH_ENDPOINTS.userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new OAuthError(`userinfo failed (${res.status})`);
  }
  const json = (await res.json()) as GoogleUserinfo;
  return {
    provider: "google",
    id: json.sub,
    email: json.email,
    name: json.name,
    avatarUrl: json.picture,
  };
}

/** Best-effort revocation; logging-only on failure. */
async function revoke(tokens: ProviderTokens): Promise<void> {
  try {
    await fetch(
      `${GOOGLE_OAUTH_ENDPOINTS.revokeEndpoint}?token=${encodeURIComponent(tokens.refreshToken)}`,
      { method: "POST" },
    );
  } catch (err) {
    console.warn("[auth] google revoke failed:", err);
  }
}

export const googleProvider: ProviderConfig = {
  id: "google",
  displayName: "Google",
  authEndpoint: () => GOOGLE_OAUTH_ENDPOINTS.authEndpoint,
  tokenEndpoint: () => GOOGLE_OAUTH_ENDPOINTS.tokenEndpoint,
  scopes: [...GOOGLE_OAUTH_ENDPOINTS.scopes],
  // access_type=offline + prompt=consent ensure we always get a refresh_token,
  // including on subsequent sign-ins of the same Google account.
  extraAuthParams: {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  },
  clientId: GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
  usesPkce: true,
  rotatesRefreshToken: false,
  requiresRefreshTokenOnExchange: true,
  requiresBaseUrl: false,
  supportsPat: false,
  mapUser,
  revoke,
};
