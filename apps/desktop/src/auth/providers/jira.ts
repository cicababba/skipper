import { JIRA_OAUTH_ENDPOINTS, normalizeBaseUrl, type ResourceCandidate } from "@skipper/shared";
import { OAuthError, type MappedAccount, type ProviderConfig } from "../provider";
import { JIRA_OAUTH_CLIENT_ID, JIRA_OAUTH_CLIENT_SECRET } from "../oauth-config";

interface AccessibleResource {
  id: string;
  name: string;
  url: string;
  scopes?: string[];
  avatarUrl?: string;
}

interface JiraSelf {
  accountId?: string;
  emailAddress?: string;
  displayName?: string;
  avatarUrls?: Record<string, string>;
}

interface JiraDataCenterSelf {
  key?: string;
  name?: string;
  emailAddress?: string;
  displayName?: string;
  avatarUrls?: Record<string, string>;
}

/** Resolve the Jira sites this token can reach. accessible-resources can list
 *  other Atlassian products (Confluence, etc.), so keep only Jira-scoped ones. */
export async function listJiraResources(accessToken: string): Promise<ResourceCandidate[]> {
  const res = await fetch(JIRA_OAUTH_ENDPOINTS.accessibleResourcesEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new OAuthError(`Jira accessible-resources failed (${res.status})`);
  }
  const json = (await res.json()) as AccessibleResource[];
  return json
    .filter((r) => !r.scopes || r.scopes.some((s) => s.includes("jira")))
    .map((r) => ({ id: r.id, name: r.name, url: r.url, avatarUrl: r.avatarUrl }));
}

/** Map the Jira Cloud identity for a chosen site. The token is unusable without
 *  a cloudId, so a resource is required. */
export async function mapJiraUser(
  accessToken: string,
  _baseUrl?: string,
  resource?: ResourceCandidate,
): Promise<MappedAccount> {
  if (!resource) {
    throw new OAuthError("Jira sign-in requires a site selection");
  }
  const res = await fetch(JIRA_OAUTH_ENDPOINTS.myselfEndpoint(resource.id), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new OAuthError(`Jira /myself failed (${res.status})`);
  }
  const json = (await res.json()) as JiraSelf;
  if (!json.accountId) {
    throw new OAuthError("Jira /myself returned no accountId");
  }
  return {
    provider: "jira",
    id: json.accountId,
    // emailAddress is hidden when the user's profile visibility restricts it.
    email: json.emailAddress ?? undefined,
    name: json.displayName,
    avatarUrl: json.avatarUrls?.["48x48"],
    baseUrl: normalizeBaseUrl(resource.url) ?? resource.url,
    cloudId: resource.id,
  };
}

/** Map a Jira Data Center identity from a PAT + instance URL (v2 REST, no cloudId). */
export async function mapJiraDataCenterUser(pat: string, baseUrl?: string): Promise<MappedAccount> {
  if (!baseUrl) {
    throw new OAuthError("A valid instance URL is required");
  }
  const res = await fetch(JIRA_OAUTH_ENDPOINTS.dcMyselfEndpoint(baseUrl), {
    headers: { authorization: `Bearer ${pat}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new OAuthError(`Jira /myself failed (${res.status})`);
  }
  const json = (await res.json()) as JiraDataCenterSelf;
  const id = json.key ?? json.name;
  if (!id) {
    throw new OAuthError("Jira /myself returned no user key");
  }
  return {
    provider: "jira",
    id,
    email: json.emailAddress ?? undefined,
    name: json.displayName ?? json.name,
    avatarUrl: json.avatarUrls?.["48x48"],
  };
}

export const jiraProvider: ProviderConfig = {
  id: "jira",
  displayName: "Jira",
  authEndpoint: () => JIRA_OAUTH_ENDPOINTS.authEndpoint,
  tokenEndpoint: () => JIRA_OAUTH_ENDPOINTS.tokenEndpoint,
  scopes: [...JIRA_OAUTH_ENDPOINTS.scopes],
  extraAuthParams: { audience: "api.atlassian.com", prompt: "consent" },
  clientId: JIRA_OAUTH_CLIENT_ID,
  clientSecret: JIRA_OAUTH_CLIENT_SECRET,
  usesPkce: false,
  rotatesRefreshToken: true,
  requiresRefreshTokenOnExchange: true,
  tokenRequestFormat: "json",
  redirectPorts: JIRA_OAUTH_ENDPOINTS.redirectPorts,
  requiresBaseUrl: false,
  patRequiresBaseUrl: true,
  needsProjectMapping: true,
  supportsPat: true,
  listResources: listJiraResources,
  mapUser: mapJiraUser,
  mapUserFromPat: mapJiraDataCenterUser,
};
