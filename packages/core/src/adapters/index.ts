import type { AuthProviderId, PlatformId } from "@skipper/shared";
import { githubIssueSource } from "./github";
import type { IssueSource } from "./types";

// Computed key: the adapter self-declares its platform, so the "github" literal
// stays inside adapters/github/. `satisfies` keeps this exhaustive as PlatformId widens.
export const issueSources = {
  [githubIssueSource.platform]: githubIssueSource,
} satisfies Record<PlatformId, IssueSource>;

export function issueSourceFor(platform: PlatformId): IssueSource {
  return issueSources[platform];
}

/** Which issue source (if any) polls accounts of this auth provider.
 *  Google → undefined (identity-only, supporter entitlement). */
export function issueSourceForAuthProvider(provider: AuthProviderId): IssueSource | undefined {
  return Object.values(issueSources).find((s) => s.authProvider === provider);
}

export * from "./types";
export * from "./github";
