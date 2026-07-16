import { GITHUB_API_BASE_URL } from "@skipper/shared";
import type { PrReviewComment, PullRequest, RepoRef } from "@skipper/shared";
import type { CreatedPr, FailingCheck } from "../types";
import { githubGet, githubPost, type GitHubResponse } from "./client";
import type { GitHubTokenProvider } from "./types";

interface CreatedPullPayload {
  id: number;
  number: number;
  html_url: string;
}

function repoUrl(repo: RepoRef): string {
  return `${GITHUB_API_BASE_URL}/repos/${repo.owner}/${repo.name}`;
}

export async function createPullRequest(
  repo: RepoRef,
  params: { title: string; body: string; head: string; base: string; draft: boolean },
  getToken: GitHubTokenProvider,
): Promise<CreatedPr> {
  const res = await githubPost<CreatedPullPayload>(`${repoUrl(repo)}/pulls`, getToken, params);
  const payload = res.body!;
  return { id: `github:${payload.id}`, number: payload.number, url: payload.html_url };
}

/** Recovery for "PR already exists" (422 on create): adopt the open PR for this head branch. */
export async function findOpenPullByHead(
  repo: RepoRef,
  head: string,
  getToken: GitHubTokenProvider,
): Promise<CreatedPr | null> {
  const params = new URLSearchParams({ head: `${repo.owner}:${head}`, state: "open" });
  const res = await githubGet<CreatedPullPayload[]>(
    `${repoUrl(repo)}/pulls?${params.toString()}`,
    getToken,
  );
  const payload = res.body?.[0];
  if (!payload) return null;
  return { id: `github:${payload.id}`, number: payload.number, url: payload.html_url };
}

export interface PullReviewPayload {
  user?: { login: string } | null;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  body?: string | null;
  submitted_at?: string;
  html_url?: string;
}

export interface PullReviewCommentPayload {
  user?: { login: string } | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  html_url?: string;
  created_at?: string;
}

async function fetchPaginated<T>(url: string, getToken: GitHubTokenProvider): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const res: GitHubResponse<T[]> = await githubGet<T[]>(next, getToken);
    out.push(...(res.body ?? []));
    next = res.nextUrl;
  }
  return out;
}

export async function fetchPullReviews(
  repo: RepoRef,
  number: number,
  getToken: GitHubTokenProvider,
): Promise<PullReviewPayload[]> {
  return fetchPaginated<PullReviewPayload>(
    `${repoUrl(repo)}/pulls/${number}/reviews?per_page=100`,
    getToken,
  );
}

export async function fetchPullReviewComments(
  repo: RepoRef,
  number: number,
  getToken: GitHubTokenProvider,
): Promise<PullReviewCommentPayload[]> {
  return fetchPaginated<PullReviewCommentPayload>(
    `${repoUrl(repo)}/pulls/${number}/comments?per_page=100`,
    getToken,
  );
}

/** REST approximation of GraphQL's reviewDecision: latest non-comment review per
 *  reviewer (PR author excluded), DISMISSED drops the vote, changes-requested wins. */
export function deriveReviewDecision(
  reviews: PullReviewPayload[],
  prAuthor?: string,
): NonNullable<PullRequest["reviewDecision"]> {
  const latest = new Map<string, PullReviewPayload>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || login === prAuthor) continue;
    const state = review.state.toUpperCase();
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") continue;
    latest.set(login, review);
  }
  let approved = false;
  for (const review of latest.values()) {
    const state = review.state.toUpperCase();
    if (state === "CHANGES_REQUESTED") return "changes-requested";
    if (state === "APPROVED") approved = true;
  }
  return approved ? "approved" : "review-required";
}

/** Human feedback for the fix prompt: change-request review bodies + inline comments. */
export function mapReviewFeedback(
  reviews: PullReviewPayload[],
  comments: PullReviewCommentPayload[],
  prAuthor?: string,
): PrReviewComment[] {
  const out: PrReviewComment[] = [];
  for (const review of reviews) {
    const login = review.user?.login;
    if (login === prAuthor) continue;
    if (review.state.toUpperCase() !== "CHANGES_REQUESTED") continue;
    const body = review.body?.trim();
    if (!body) continue;
    out.push({
      author: login,
      body,
      url: review.html_url,
      submittedAt: review.submitted_at,
    });
  }
  for (const comment of comments) {
    const login = comment.user?.login;
    if (login === prAuthor) continue;
    const body = comment.body?.trim();
    if (!body) continue;
    out.push({
      author: login,
      path: comment.path,
      line: comment.line ?? comment.original_line ?? undefined,
      body,
      url: comment.html_url,
      submittedAt: comment.created_at,
    });
  }
  return out;
}

interface CheckRunsPayload {
  check_runs?: Array<{
    status?: string;
    conclusion?: string | null;
    name?: string;
    html_url?: string;
    output?: { title?: string | null; summary?: string | null };
  }>;
}

interface CombinedStatusPayload {
  state?: string; // success | pending | failure | error
  total_count?: number;
}

const FAILING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

export async function fetchCiStatus(
  repo: RepoRef,
  sha: string,
  getToken: GitHubTokenProvider,
): Promise<PullRequest["ciStatus"]> {
  const [checks, status] = await Promise.all([
    githubGet<CheckRunsPayload>(`${repoUrl(repo)}/commits/${sha}/check-runs?per_page=100`, getToken),
    githubGet<CombinedStatusPayload>(`${repoUrl(repo)}/commits/${sha}/status`, getToken),
  ]);

  const runs = checks.body?.check_runs ?? [];
  const combined = status.body?.state;
  const hasStatuses = (status.body?.total_count ?? 0) > 0;

  const failing =
    runs.some((r) => FAILING_CONCLUSIONS.has(r.conclusion ?? "")) ||
    (hasStatuses && (combined === "failure" || combined === "error"));
  if (failing) return "failing";

  const pending =
    runs.some((r) => r.status === "queued" || r.status === "in_progress") ||
    (hasStatuses && combined === "pending");
  if (pending) return "pending";

  const passing =
    runs.some((r) => r.conclusion === "success") || (hasStatuses && combined === "success");
  if (passing) return "passing";

  return undefined;
}

/** The failed check runs on a commit — feeds the CI-fix re-entry prompt (name + summary). */
export async function fetchFailingChecks(
  repo: RepoRef,
  sha: string,
  getToken: GitHubTokenProvider,
): Promise<FailingCheck[]> {
  const checks = await githubGet<CheckRunsPayload>(
    `${repoUrl(repo)}/commits/${sha}/check-runs?per_page=100`,
    getToken,
  );
  return (checks.body?.check_runs ?? [])
    .filter((r) => FAILING_CONCLUSIONS.has(r.conclusion ?? ""))
    .map((r) => ({
      name: r.name ?? "unnamed check",
      url: r.html_url ?? undefined,
      summary: r.output?.title ?? r.output?.summary ?? undefined,
    }));
}
