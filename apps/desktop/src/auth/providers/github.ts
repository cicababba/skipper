import { GITHUB_OAUTH_ENDPOINTS, type Account } from "@nestbrain/shared";
import { OAuthError, type ProviderConfig, type ProviderTokens } from "../provider";
import { GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET } from "../oauth-config";

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url?: string;
}

export async function mapGitHubUser(accessToken: string): Promise<Account> {
  const res = await fetch(GITHUB_OAUTH_ENDPOINTS.userEndpoint, {
    headers: { ...API_HEADERS, authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new OAuthError(`GitHub /user failed (${res.status})`);
  }
  const json = (await res.json()) as GitHubUser;
  return {
    provider: "github",
    id: String(json.id),
    email: json.email ?? (await fetchPrimaryEmail(accessToken)),
    name: json.name ?? json.login,
    avatarUrl: json.avatar_url,
  };
}

// /user only exposes the public profile email; the verified primary lives
// behind the Email-addresses App permission. Missing email is not fatal.
async function fetchPrimaryEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(GITHUB_OAUTH_ENDPOINTS.emailsEndpoint, {
      headers: { ...API_HEADERS, authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const emails = (await res.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    return emails.find((e) => e.primary && e.verified)?.email;
  } catch {
    return undefined;
  }
}

/** Best-effort revocation of the whole app grant; logging-only on failure. */
async function revoke(tokens: ProviderTokens): Promise<void> {
  try {
    const basic = Buffer.from(`${GITHUB_OAUTH_CLIENT_ID}:${GITHUB_OAUTH_CLIENT_SECRET}`).toString("base64");
    await fetch(`${GITHUB_OAUTH_ENDPOINTS.grantEndpointBase}/${GITHUB_OAUTH_CLIENT_ID}/grant`, {
      method: "DELETE",
      headers: { ...API_HEADERS, authorization: `Basic ${basic}` },
      body: JSON.stringify({ access_token: tokens.accessToken }),
    });
  } catch (err) {
    console.warn("[auth] github revoke failed:", err);
  }
}

export const githubProvider: ProviderConfig = {
  id: "github",
  displayName: "GitHub",
  authEndpoint: GITHUB_OAUTH_ENDPOINTS.authEndpoint,
  tokenEndpoint: GITHUB_OAUTH_ENDPOINTS.tokenEndpoint,
  // GitHub Apps take no scope param — permissions live on the App itself.
  scopes: [],
  clientId: GITHUB_OAUTH_CLIENT_ID,
  clientSecret: GITHUB_OAUTH_CLIENT_SECRET,
  usesPkce: false,
  rotatesRefreshToken: true,
  requiresRefreshTokenOnExchange: true,
  redirectPorts: GITHUB_OAUTH_ENDPOINTS.redirectPorts,
  mapUser: mapGitHubUser,
  revoke,
};
