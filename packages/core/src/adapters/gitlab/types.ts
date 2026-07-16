import type { PollOptions, PollResult, RateLimit, TokenProvider } from "../types";

export type GitLabTokenProvider = TokenProvider;
export type GitLabRateLimit = RateLimit;

export interface GitLabStreamCursor {
  /** ISO timestamp for the next `updated_after=` param (max updated_at seen − 60s overlap). */
  updatedAfter?: string;
}

export interface GitLabAccountCursor {
  version: 1;
  issues: GitLabStreamCursor;
  mergeRequests: GitLabStreamCursor;
  lastPolledAt?: string;
}

export type GitLabPollOptions = PollOptions<GitLabAccountCursor>;
export type GitLabPollResult = PollResult<GitLabAccountCursor>;

/** The cursor arrives opaque (unknown) through the port — accept only the exact
 *  v1 shape; anything else means full walk. */
export function asGitLabCursor(cursor: unknown): GitLabAccountCursor | undefined {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const c = cursor as Partial<GitLabAccountCursor>;
  if (c.version !== 1) return undefined;
  if (typeof c.issues !== "object" || c.issues === null) return undefined;
  if (typeof c.mergeRequests !== "object" || c.mergeRequests === null) return undefined;
  return c as GitLabAccountCursor;
}

export function emptyGitLabCursor(): GitLabAccountCursor {
  return { version: 1, issues: {}, mergeRequests: {} };
}
