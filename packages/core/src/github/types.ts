import type { Issue, PullRequest } from "@nestbrain/shared";

/** Returns a valid access token, or null when no account is available.
 *  `forceRefresh` bypasses the cached token — used after a 401. */
export type GitHubTokenProvider = (forceRefresh?: boolean) => Promise<string | null>;

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

export interface GitHubRateLimit {
  remaining: number;
  resetAt: string; // ISO
}

export interface GitHubPollOptions {
  accountId: string;
  getToken: GitHubTokenProvider;
  /** undefined (or version mismatch) → full walk of the current open set. */
  cursor?: GitHubAccountCursor;
  /** Tracked PRs to hydrate unconditionally each poll (#11) — reviews and CI
   *  don't bump the PR's updated_at, so deltas alone would never surface them. */
  deepHydrate?: Array<{ owner: string; name: string; number: number }>;
  onProgress?: (message: string) => void;
}

export interface GitHubPollResult {
  /** "full" → replace the account snapshot; "delta" → upsert by id
   *  (closed issues / merged PRs arrive as delta items with their new state). */
  mode: "full" | "delta";
  issues: Issue[];
  pullRequests: PullRequest[];
  cursor: GitHubAccountCursor;
  rateLimit?: GitHubRateLimit;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimit?: GitHubRateLimit,
    /** Seconds to wait before retrying (from Retry-After / X-RateLimit-Reset). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** 401 that survived one force-refresh retry, or no token available — re-auth needed. */
export class GitHubAuthError extends GitHubApiError {
  constructor(message: string) {
    super(message, 401);
    this.name = "GitHubAuthError";
  }
}

export function emptyGitHubCursor(): GitHubAccountCursor {
  return { version: 1, assigned: { etags: {} }, created: { etags: {} } };
}
