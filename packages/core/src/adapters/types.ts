// ============================================================
// Skipper — IssueSource + CodeHost ports (epic #68, issues #69/#70)
// ============================================================

import type {
  AuthProviderId,
  CodeHostId,
  Issue,
  IssueSourceId,
  PrReviewComment,
  PullRequest,
  RepoRef,
} from "@skipper/shared";

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
  readonly id: IssueSourceId;
  /** Which AuthProviderId's accounts this source polls. */
  readonly authProvider: AuthProviderId;
  // Method syntax (not an arrow property) — bivariance lets IssueSource<ConcreteCursor>
  // satisfy Record<IssueSourceId, IssueSource> under strictFunctionTypes.
  poll(opts: PollOptions<C>): Promise<PollResult<C>>;
}

export interface CreatePrParams {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface CreatedPr {
  /** Adapter-namespaced, e.g. "github:123456". */
  id: string;
  number: number;
  url: string;
  /** Set when createPr adopted an already-open PR for this head instead of creating one. */
  existing?: boolean;
}

export interface PrReviews {
  decision: NonNullable<PullRequest["reviewDecision"]>;
  /** Change-request review bodies + inline comments, ready for the fix prompt. */
  comments: PrReviewComment[];
}

export interface FailingCheck {
  name: string;
  url?: string;
  summary?: string;
}

/** Askpass identity for git-over-HTTPS pushes — a host convention
 *  (GitHub: x-access-token, GitLab: oauth2). */
export interface PushCredentials {
  username: string;
  password: string;
}

export interface CodeHost {
  readonly id: CodeHostId;
  /** Which AuthProviderId's accounts authenticate against this host. */
  readonly authProvider: AuthProviderId;
  /** Opens the PR. "Already exists" is a host convention handled inside the
   *  adapter: it adopts the open PR for this head and returns it flagged `existing`. */
  createPr(repo: RepoRef, params: CreatePrParams, getToken: TokenProvider): Promise<CreatedPr>;
  findOpenPrByHead(
    repo: RepoRef,
    headRef: string,
    getToken: TokenProvider,
  ): Promise<CreatedPr | null>;
  /** prAuthor (optional) excludes the author's own reviews from decision and comments. */
  fetchReviews(
    repo: RepoRef,
    number: number,
    getToken: TokenProvider,
    prAuthor?: string,
  ): Promise<PrReviews>;
  fetchCiStatus(
    repo: RepoRef,
    sha: string,
    getToken: TokenProvider,
  ): Promise<PullRequest["ciStatus"]>;
  fetchFailingChecks(repo: RepoRef, sha: string, getToken: TokenProvider): Promise<FailingCheck[]>;
  /** The tracker-link line in the PR body, e.g. "Closes #42" for key "42". */
  linkIssueText(key: string): string;
  pushCredentials(token: string): PushCredentials;
  /** Clone URL for git-over-HTTPS, e.g. "https://github.com/owner/name.git". */
  cloneUrl(repo: RepoRef): string;
  /** Parses a git remote URL into this host's owner/name; null when it isn't this host. */
  parseOrigin(remoteUrl: string): RepoRef | null;
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
