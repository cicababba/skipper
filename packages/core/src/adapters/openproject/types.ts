import type { PollOptions, PollResult, TokenProvider } from "../types";

export type OpenProjectTokenProvider = TokenProvider;

export interface OpenProjectStreamCursor {
  /** ISO-UTC of the max `updatedAt` seen (raw — the overlap is applied at read
   *  time, like the Jira adapter). */
  updatedAfter?: string;
}

export interface OpenProjectAccountCursor {
  version: 1;
  issues: OpenProjectStreamCursor;
  lastPolledAt?: string;
}

export type OpenProjectPollOptions = PollOptions<OpenProjectAccountCursor>;
export type OpenProjectPollResult = PollResult<OpenProjectAccountCursor>;

/** The cursor arrives opaque (unknown) through the port — accept only the exact
 *  v1 shape; anything else means full walk. */
export function asOpenProjectCursor(cursor: unknown): OpenProjectAccountCursor | undefined {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const c = cursor as Partial<OpenProjectAccountCursor>;
  if (c.version !== 1) return undefined;
  if (typeof c.issues !== "object" || c.issues === null) return undefined;
  return c as OpenProjectAccountCursor;
}

export function emptyOpenProjectCursor(): OpenProjectAccountCursor {
  return { version: 1, issues: {} };
}
