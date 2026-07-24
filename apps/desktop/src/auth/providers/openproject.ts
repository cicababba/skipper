import { OPENPROJECT_OAUTH_ENDPOINTS } from "@skipper/shared";
import { OAuthError, type MappedAccount, type ProviderConfig } from "../provider";

interface OpenProjectUser {
  id?: number;
  name?: string;
  login?: string;
  email?: string;
  avatar?: string;
}

async function fetchOpenProjectMe(baseUrl: string, authHeader: string): Promise<MappedAccount> {
  const res = await fetch(OPENPROJECT_OAUTH_ENDPOINTS.meEndpoint(baseUrl), {
    headers: { authorization: authHeader, accept: "application/json" },
  });
  if (!res.ok) {
    throw new OAuthError(`OpenProject /users/me failed (${res.status})`);
  }
  const json = (await res.json()) as OpenProjectUser;
  if (json.id == null) {
    throw new OAuthError("OpenProject /users/me returned no id");
  }
  return {
    provider: "openproject",
    id: String(json.id),
    email: json.email ?? undefined,
    name: json.name ?? json.login,
    avatarUrl: json.avatar,
  };
}

/** Map the OpenProject identity from an OAuth access token (Bearer). */
export async function mapOpenProjectUser(
  accessToken: string,
  baseUrl?: string,
): Promise<MappedAccount> {
  if (!baseUrl) {
    throw new OAuthError("A valid instance URL is required");
  }
  return fetchOpenProjectMe(baseUrl, `Bearer ${accessToken}`);
}

/** Map the OpenProject identity from an API key (HTTP Basic, username `apikey`). */
export async function mapOpenProjectPatUser(
  pat: string,
  baseUrl?: string,
): Promise<MappedAccount> {
  if (!baseUrl) {
    throw new OAuthError("A valid instance URL is required");
  }
  const basic = Buffer.from(`apikey:${pat}`).toString("base64");
  return fetchOpenProjectMe(baseUrl, `Basic ${basic}`);
}

export const openprojectProvider: ProviderConfig = {
  id: "openproject",
  displayName: "OpenProject",
  authEndpoint: (baseUrl) => OPENPROJECT_OAUTH_ENDPOINTS.authEndpoint(baseUrl ?? ""),
  tokenEndpoint: (baseUrl) => OPENPROJECT_OAUTH_ENDPOINTS.tokenEndpoint(baseUrl ?? ""),
  scopes: [...OPENPROJECT_OAUTH_ENDPOINTS.scopes],
  // Empty: the user registers a public client on their own instance and pastes
  // its Client ID at connect time (clientIdFromUser).
  clientId: "",
  clientIdFromUser: true,
  usesPkce: true,
  rotatesRefreshToken: true,
  requiresRefreshTokenOnExchange: true,
  redirectPorts: OPENPROJECT_OAUTH_ENDPOINTS.redirectPorts,
  requiresBaseUrl: true,
  needsProjectMapping: true,
  supportsPat: true,
  mapUser: mapOpenProjectUser,
  mapUserFromPat: mapOpenProjectPatUser,
};
