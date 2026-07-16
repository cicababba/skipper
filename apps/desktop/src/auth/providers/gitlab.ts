import { GITLAB_BASE_URL, GITLAB_OAUTH_ENDPOINTS, type Account } from "@skipper/shared";
import { OAuthError, type ProviderConfig, type ProviderTokens } from "../provider";
import { GITLAB_OAUTH_CLIENT_ID } from "../oauth-config";

interface GitLabUser {
  id: number;
  username: string;
  name: string | null;
  email: string | null;
  avatar_url?: string;
}

// One mapper serves OAuth and PAT: GitLab accepts a personal access token as a
// Bearer token, same as an OAuth access token.
export async function mapGitLabUser(accessToken: string, baseUrl?: string): Promise<Account> {
  const res = await fetch(GITLAB_OAUTH_ENDPOINTS.userEndpoint(baseUrl), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new OAuthError(`GitLab /user failed (${res.status})`);
  }
  const json = (await res.json()) as GitLabUser;
  return {
    provider: "gitlab",
    id: String(json.id),
    email: json.email ?? undefined,
    name: json.name ?? json.username,
    avatarUrl: json.avatar_url,
  };
}

/** Best-effort revocation; logging-only on failure. Public client → no secret. */
async function revoke(tokens: ProviderTokens, baseUrl?: string): Promise<void> {
  try {
    await fetch(GITLAB_OAUTH_ENDPOINTS.revokeEndpoint(baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GITLAB_OAUTH_CLIENT_ID, token: tokens.accessToken }),
    });
  } catch (err) {
    console.warn("[auth] gitlab revoke failed:", err);
  }
}

export const gitlabProvider: ProviderConfig = {
  id: "gitlab",
  displayName: "GitLab",
  authEndpoint: (baseUrl) => GITLAB_OAUTH_ENDPOINTS.authEndpoint(baseUrl),
  tokenEndpoint: (baseUrl) => GITLAB_OAUTH_ENDPOINTS.tokenEndpoint(baseUrl),
  scopes: [...GITLAB_OAUTH_ENDPOINTS.scopes],
  clientId: GITLAB_OAUTH_CLIENT_ID,
  usesPkce: true,
  rotatesRefreshToken: true,
  requiresRefreshTokenOnExchange: true,
  redirectPorts: GITLAB_OAUTH_ENDPOINTS.redirectPorts,
  requiresBaseUrl: true,
  defaultBaseUrl: GITLAB_BASE_URL,
  supportsPat: true,
  mapUser: mapGitLabUser,
  mapUserFromPat: mapGitLabUser,
  revoke,
};
