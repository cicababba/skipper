import type { PollOptions, PollResult, TokenProvider } from "../types";

export type BitbucketTokenProvider = TokenProvider;

export interface BitbucketStreamCursor {
  /** ISO timestamp for the next `updated_on >` query (max updated_on seen − 60s overlap). */
  updatedAfter?: string;
}

export interface BitbucketAccountCursor {
  version: 1;
  issues: BitbucketStreamCursor;
  pullRequests: BitbucketStreamCursor;
  lastPolledAt?: string;
}

export type BitbucketPollOptions = PollOptions<BitbucketAccountCursor>;
export type BitbucketPollResult = PollResult<BitbucketAccountCursor>;

/** The cursor arrives opaque (unknown) through the port — accept only the exact
 *  v1 shape; anything else means full walk. */
export function asBitbucketCursor(cursor: unknown): BitbucketAccountCursor | undefined {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const c = cursor as Partial<BitbucketAccountCursor>;
  if (c.version !== 1) return undefined;
  if (typeof c.issues !== "object" || c.issues === null) return undefined;
  if (typeof c.pullRequests !== "object" || c.pullRequests === null) return undefined;
  return c as BitbucketAccountCursor;
}

export function emptyBitbucketCursor(): BitbucketAccountCursor {
  return { version: 1, issues: {}, pullRequests: {} };
}
