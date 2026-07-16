import type { PollOptions, PollResult, RateLimit, TokenProvider } from "../types";

export type GitHubTokenProvider = TokenProvider;
export type GitHubRateLimit = RateLimit;

export interface GitHubEndpointCursor {
  /** ISO timestamp for the next `since=` param (max updated_at seen − 60s overlap). */
  since?: string;
  /** ETag per full request URL from the last successful poll. */
  etags: Record<string, string>;
}

export interface GitHubAccountCursor {
  version: 1;
  assigned: GitHubEndpointCursor;
  created: GitHubEndpointCursor;
  lastPolledAt?: string;
}

export type GitHubPollOptions = PollOptions<GitHubAccountCursor>;
export type GitHubPollResult = PollResult<GitHubAccountCursor>;

/** The cursor arrives opaque (unknown) through the port — accept only the exact
 *  v1 shape; anything else means full walk. */
export function asGitHubCursor(cursor: unknown): GitHubAccountCursor | undefined {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const c = cursor as Partial<GitHubAccountCursor>;
  if (c.version !== 1) return undefined;
  if (typeof c.assigned !== "object" || c.assigned === null) return undefined;
  if (typeof c.created !== "object" || c.created === null) return undefined;
  return c as GitHubAccountCursor;
}

export function emptyGitHubCursor(): GitHubAccountCursor {
  return { version: 1, assigned: { etags: {} }, created: { etags: {} } };
}
