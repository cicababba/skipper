import { BITBUCKET_OAUTH_ENDPOINTS } from "@skipper/shared";
import { OAuthError, type MappedAccount, type ProviderConfig } from "../provider";
import { BITBUCKET_OAUTH_CLIENT_ID, BITBUCKET_OAUTH_CLIENT_SECRET } from "../oauth-config";

// Bitbucket CLOUD only. Bitbucket Data Center (self-hosted) is a different
// product with a different REST API (/rest/api/1.0/) — out of scope (#80).

interface BitbucketUser {
  uuid?: string; // curly-braced, e.g. "{a1b2...}"
  account_id?: string;
  display_name?: string;
  nickname?: string;
  links?: { avatar?: { href?: string } };
}

export async function mapBitbucketUser(accessToken: string): Promise<MappedAccount> {
  const res = await fetch(BITBUCKET_OAUTH_ENDPOINTS.userEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new OAuthError(`Bitbucket /user failed (${res.status})`);
  }
  const json = (await res.json()) as BitbucketUser;
  // Identity keys on uuid — username/nickname are mutable and deprecated.
  if (!json.uuid) {
    throw new OAuthError("Bitbucket /user returned no uuid");
  }
  return {
    provider: "bitbucket",
    id: json.uuid,
    email: await fetchPrimaryEmail(accessToken),
    name: json.display_name ?? json.nickname,
    avatarUrl: json.links?.avatar?.href,
  };
}

// /2.0/user carries no email; /2.0/user/emails is covered by the `account`
// scope. Missing email is not fatal (Account.email is optional).
async function fetchPrimaryEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(BITBUCKET_OAUTH_ENDPOINTS.emailsEndpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      values?: { email: string; is_primary: boolean; is_confirmed: boolean }[];
    };
    return json.values?.find((e) => e.is_primary && e.is_confirmed)?.email;
  } catch {
    return undefined;
  }
}

export const bitbucketProvider: ProviderConfig = {
  id: "bitbucket",
  displayName: "Bitbucket",
  authEndpoint: () => BITBUCKET_OAUTH_ENDPOINTS.authEndpoint,
  tokenEndpoint: () => BITBUCKET_OAUTH_ENDPOINTS.tokenEndpoint,
  scopes: [...BITBUCKET_OAUTH_ENDPOINTS.scopes],
  clientId: BITBUCKET_OAUTH_CLIENT_ID,
  clientSecret: BITBUCKET_OAUTH_CLIENT_SECRET,
  usesPkce: false,
  rotatesRefreshToken: true,
  requiresRefreshTokenOnExchange: true,
  tokenAuth: "basic",
  // No redirectPorts: Bitbucket prefix-matches the callback URL and ignores
  // the loopback port (RFC 8252) — any free port works.
  requiresBaseUrl: false,
  supportsPat: false,
  mapUser: mapBitbucketUser,
};
