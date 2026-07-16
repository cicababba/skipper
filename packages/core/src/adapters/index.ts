import type { AuthProviderId, CodeHostId, IssueSourceId } from "@skipper/shared";
import { githubCodeHost, githubIssueSource } from "./github";
import { gitlabIssueSource } from "./gitlab";
import type { CodeHost, IssueSource } from "./types";

// `satisfies` keeps this exhaustive as the IssueSourceId axis widens — a new id
// forces a new entry here. Literal keys (not `[adapter.id]`): once the union has
// more than one member a computed key widens to a string index signature that no
// longer satisfies the exact Record.
export const issueSources = {
  github: githubIssueSource,
  gitlab: gitlabIssueSource,
} satisfies Record<IssueSourceId, IssueSource>;

export function issueSourceFor(source: IssueSourceId): IssueSource {
  return issueSources[source];
}

// Partial: GitLab widened CodeHostId but its CodeHost adapter is #76.
export const codeHosts = {
  [githubCodeHost.id]: githubCodeHost,
} satisfies Partial<Record<CodeHostId, CodeHost>>;

export function codeHostFor(host: CodeHostId): CodeHost {
  const adapter = codeHosts[host];
  if (!adapter) throw new Error(`no CodeHost adapter for ${host}`); // #76
  return adapter;
}

/** Which issue source (if any) polls accounts of this auth provider.
 *  Google → undefined (identity-only, supporter entitlement). */
export function issueSourceForAuthProvider(provider: AuthProviderId): IssueSource | undefined {
  return Object.values(issueSources).find((s) => s.authProvider === provider);
}

export * from "./types";
export * from "./github";
export * from "./gitlab";
