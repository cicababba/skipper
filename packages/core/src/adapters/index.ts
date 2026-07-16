import type { AuthProviderId, CodeHostId, IssueSourceId } from "@skipper/shared";
import { githubCodeHost, githubIssueSource } from "./github";
import type { CodeHost, IssueSource } from "./types";

// Computed key: the adapter self-declares its id, so the "github" literal
// stays inside adapters/github/. `satisfies` keeps this exhaustive as the axes widen.
export const issueSources = {
  [githubIssueSource.id]: githubIssueSource,
} satisfies Record<IssueSourceId, IssueSource>;

export function issueSourceFor(source: IssueSourceId): IssueSource {
  return issueSources[source];
}

export const codeHosts = {
  [githubCodeHost.id]: githubCodeHost,
} satisfies Record<CodeHostId, CodeHost>;

export function codeHostFor(host: CodeHostId): CodeHost {
  return codeHosts[host];
}

/** Which issue source (if any) polls accounts of this auth provider.
 *  Google → undefined (identity-only, supporter entitlement). */
export function issueSourceForAuthProvider(provider: AuthProviderId): IssueSource | undefined {
  return Object.values(issueSources).find((s) => s.authProvider === provider);
}

export * from "./types";
export * from "./github";
