// ============================================================
// Skipper — IssueSource port (epic #68, issue #69)
// ============================================================

import type { AuthProviderId, Issue, PlatformId, PullRequest } from "@skipper/shared";

/** Returns a valid access token, or null when no account is available.
 *  `forceRefresh` bypasses the cached token — used after a 401. */
export type TokenProvider = (forceRefresh?: boolean) => Promise<string | null>;

export interface RateLimit {
  remaining: number;
  resetAt: string; // ISO
}

export interface PollOptions<C = unknown> {
  accountId: string;
  getToken: TokenProvider;
  /** Opaque cursor from the previous poll. undefined (or a shape the adapter
   *  doesn't recognize) → full walk of the current open set. */
  cursor?: C;
  /** Tracked PRs to hydrate unconditionally each poll (#11) — reviews and CI
   *  don't bump the PR's updated_at, so deltas alone would never surface them. */
  deepHydrate?: Array<{ owner: string; name: string; number: number }>;
  onProgress?: (message: string) => void;
}

export interface PollResult<C = unknown> {
  /** "full" → replace the account snapshot; "delta" → upsert by id
   *  (closed issues / merged PRs arrive as delta items with their new state). */
  mode: "full" | "delta";
  issues: Issue[];
  pullRequests: PullRequest[];
  /** Opaque — the caller persists it and hands it back next poll, never reads it. */
  cursor: C;
  rateLimit?: RateLimit;
}

export interface IssueSource<C = unknown> {
  readonly platform: PlatformId;
  /** Which AuthProviderId's accounts this source polls. */
  readonly authProvider: AuthProviderId;
  // Method syntax (not an arrow property) — bivariance lets IssueSource<ConcreteCursor>
  // satisfy Record<PlatformId, IssueSource> under strictFunctionTypes.
  poll(opts: PollOptions<C>): Promise<PollResult<C>>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimit?: RateLimit,
    /** Seconds to wait before retrying (from Retry-After / X-RateLimit-Reset). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 401 that survived one force-refresh retry, or no token available — re-auth needed. */
export class AuthError extends ApiError {
  constructor(message: string) {
    super(message, 401);
    this.name = "AuthError";
  }
}
