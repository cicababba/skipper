import type { AuthProviderId, CodeHostId, IssueSourceId } from "@skipper/shared";
import { githubCodeHost, githubIssueSource } from "./github";
import { gitlabCodeHost, gitlabIssueSource } from "./gitlab";
import { jiraIssueSource } from "./jira";
import type { CodeHost, IssueSource } from "./types";

// `satisfies` keeps this exhaustive as the IssueSourceId axis widens — a new id
// forces a new entry here. Literal keys (not `[adapter.id]`): once the union has
// more than one member a computed key widens to a string index signature that no
// longer satisfies the exact Record.
export const issueSources = {
  github: githubIssueSource,
  gitlab: gitlabIssueSource,
  jira: jiraIssueSource,
} satisfies Record<IssueSourceId, IssueSource>;

export function issueSourceFor(source: IssueSourceId): IssueSource {
  return issueSources[source];
}

// Literal keys (not `[adapter.id]`) so the exact Record stays satisfied — see the
// issueSources note above.
export const codeHosts = {
  github: githubCodeHost,
  gitlab: gitlabCodeHost,
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
export * from "./gitlab";
export * from "./jira";
