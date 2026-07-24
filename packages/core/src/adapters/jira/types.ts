import type { PollOptions, PollResult, TokenProvider } from "../types";

export type JiraTokenProvider = TokenProvider;

export interface JiraStreamCursor {
  /** ISO-UTC of the max `fields.updated` seen (raw — the overlap is applied at read
   *  time, unlike GitLab which bakes it in at store time). */
  updatedAfter?: string;
}

export interface JiraAccountCursor {
  version: 1;
  issues: JiraStreamCursor;
  lastPolledAt?: string;
}

export type JiraPollOptions = PollOptions<JiraAccountCursor>;
export type JiraPollResult = PollResult<JiraAccountCursor>;

/** The cursor arrives opaque (unknown) through the port — accept only the exact
 *  v1 shape; anything else means full walk. */
export function asJiraCursor(cursor: unknown): JiraAccountCursor | undefined {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const c = cursor as Partial<JiraAccountCursor>;
  if (c.version !== 1) return undefined;
  if (typeof c.issues !== "object" || c.issues === null) return undefined;
  return c as JiraAccountCursor;
}

export function emptyJiraCursor(): JiraAccountCursor {
  return { version: 1, issues: {} };
}
