import { GITHUB_API_BASE_URL } from "@nestbrain/shared";
import type { Issue, PullRequest } from "@nestbrain/shared";
import { githubGet } from "./client";
import {
  applyPullDetails,
  mapIssue,
  mapPullDetail,
  mapPullFromIssue,
  type GitHubIssuePayload,
  type GitHubPullPayload,
} from "./map";
import { deriveReviewDecision, fetchCiStatus, fetchPullReviews } from "./pulls";
import {
  GitHubApiError,
  emptyGitHubCursor,
  type GitHubAccountCursor,
  type GitHubEndpointCursor,
  type GitHubPollOptions,
  type GitHubPollResult,
  type GitHubRateLimit,
  type GitHubTokenProvider,
} from "./types";

// since= overlap absorbing clock skew between GitHub servers; duplicates are
// harmless because consumers upsert by id.
const SINCE_OVERLAP_MS = 60_000;
const HYDRATION_CAP = 50;
const DEEP_HYDRATION_CAP = 20;

interface StreamResult {
  payloads: GitHubIssuePayload[];
  cursor: GitHubEndpointCursor;
  rateLimit?: GitHubRateLimit;
}

async function walkStream(
  filter: "assigned" | "created",
  getToken: GitHubTokenProvider,
  cursor: GitHubEndpointCursor | undefined,
  onProgress?: (message: string) => void,
): Promise<StreamResult> {
  const params = new URLSearchParams({ filter, per_page: "100" });
  if (cursor?.since) {
    params.set("state", "all");
    params.set("since", cursor.since);
  } else {
    params.set("state", "open");
  }
  const pageOneUrl = `${GITHUB_API_BASE_URL}/issues?${params.toString()}`;

  const etags: Record<string, string> = {};
  const payloads: GitHubIssuePayload[] = [];
  let rateLimit: GitHubRateLimit | undefined;

  // Conditional request on page 1 only: a 304 mid-pagination has no body or
  // Link header and would break the walk.
  const first = await githubGet<GitHubIssuePayload[]>(pageOneUrl, getToken, {
    etag: cursor?.etags[pageOneUrl],
  });
  rateLimit = first.rateLimit ?? rateLimit;
  if (first.status === 304) {
    onProgress?.(`${filter}: not modified`);
    return { payloads: [], cursor: cursor ?? { etags: {} }, rateLimit };
  }
  if (first.etag) etags[pageOneUrl] = first.etag;
  payloads.push(...(first.body ?? []));

  let nextUrl = first.nextUrl;
  while (nextUrl) {
    const page = await githubGet<GitHubIssuePayload[]>(nextUrl, getToken);
    rateLimit = page.rateLimit ?? rateLimit;
    payloads.push(...(page.body ?? []));
    nextUrl = page.nextUrl;
  }

  let since = cursor?.since;
  if (payloads.length > 0) {
    const maxUpdated = Math.max(...payloads.map((p) => Date.parse(p.updated_at)));
    since = new Date(maxUpdated - SINCE_OVERLAP_MS).toISOString();
  }
  onProgress?.(`${filter}: ${payloads.length} items`);
  return { payloads, cursor: { since, etags }, rateLimit };
}

function pullKey(repo: { owner: string; name: string }, number: number): string {
  return `${repo.owner}/${repo.name}#${number}`;
}

async function hydratePulls(
  pulls: PullRequest[],
  getToken: GitHubTokenProvider,
  onProgress?: (message: string) => void,
  skipKeys?: Set<string>,
): Promise<PullRequest[]> {
  const out: PullRequest[] = [];
  let hydrated = 0;
  for (const pr of pulls) {
    if (pr.state !== "open" || hydrated >= HYDRATION_CAP || skipKeys?.has(pullKey(pr.repo, pr.number))) {
      out.push(pr);
      continue;
    }
    hydrated++;
    const url = `${GITHUB_API_BASE_URL}/repos/${pr.repo.owner}/${pr.repo.name}/pulls/${pr.number}`;
    try {
      const res = await githubGet<GitHubPullPayload>(url, getToken);
      out.push(res.body ? applyPullDetails(pr, res.body) : pr);
    } catch (err) {
      // Non-fatal: keep the list-level PR without head/base details.
      onProgress?.(`pull details failed for ${pr.repo.owner}/${pr.repo.name}#${pr.number}: ${String(err)}`);
      out.push(pr);
    }
  }
  return out;
}

// Tracked PRs (#11): reviews and CI never bump updated_at, so these are fetched
// unconditionally each poll — detail, then review decision + CI while still open.
async function hydrateTrackedPulls(
  targets: NonNullable<GitHubPollOptions["deepHydrate"]>,
  accountId: string,
  getToken: GitHubTokenProvider,
  onProgress?: (message: string) => void,
): Promise<PullRequest[]> {
  if (targets.length > DEEP_HYDRATION_CAP) {
    onProgress?.(`deep hydration capped at ${DEEP_HYDRATION_CAP} of ${targets.length} tracked PRs`);
  }
  const out: PullRequest[] = [];
  for (const target of targets.slice(0, DEEP_HYDRATION_CAP)) {
    const repo = { owner: target.owner, name: target.name };
    const label = `${target.owner}/${target.name}#${target.number}`;
    try {
      const detail = await githubGet<GitHubPullPayload>(
        `${GITHUB_API_BASE_URL}/repos/${target.owner}/${target.name}/pulls/${target.number}`,
        getToken,
      );
      if (!detail.body) continue;
      const pr = mapPullDetail(detail.body, accountId, repo);
      if (pr.state !== "open") {
        out.push(pr);
        continue;
      }
      const reviews = await fetchPullReviews(repo, target.number, getToken);
      const ciStatus = await fetchCiStatus(repo, detail.body.head.sha, getToken);
      out.push({ ...pr, reviewDecision: deriveReviewDecision(reviews, pr.author), ciStatus });
    } catch (err) {
      // Non-fatal: the next poll retries; reconcile just sees no fresh evidence.
      onProgress?.(`deep hydration failed for ${label}: ${String(err)}`);
    }
  }
  return out;
}

export async function pollGitHubAccount(options: GitHubPollOptions): Promise<GitHubPollResult> {
  const cursor = options.cursor?.version === 1 ? options.cursor : undefined;
  try {
    return await runPoll(options, cursor);
  } catch (err) {
    // GitHub rejects a malformed `since` with 422 — recover with a full walk.
    if (cursor && err instanceof GitHubApiError && err.status === 422) {
      options.onProgress?.("cursor rejected (422) — falling back to full walk");
      return runPoll(options, undefined);
    }
    throw err;
  }
}

async function runPoll(
  options: GitHubPollOptions,
  cursor: GitHubAccountCursor | undefined,
): Promise<GitHubPollResult> {
  const { accountId, getToken, onProgress } = options;
  const mode = cursor ? "delta" : "full";

  const assigned = await walkStream("assigned", getToken, cursor?.assigned, onProgress);
  const created = await walkStream("created", getToken, cursor?.created, onProgress);

  const issues: Issue[] = assigned.payloads
    .filter((p) => !p.pull_request)
    .map((p) => mapIssue(p, accountId));
  const listPulls: PullRequest[] = created.payloads
    .filter((p) => p.pull_request)
    .map((p) => mapPullFromIssue(p, accountId));

  const deepTargets = options.deepHydrate ?? [];
  const deepKeys = new Set(deepTargets.map((t) => pullKey(t, t.number)));
  const pullRequests = await hydratePulls(listPulls, getToken, onProgress, deepKeys);
  const deepPulls = await hydrateTrackedPulls(deepTargets, accountId, getToken, onProgress);

  // Merge by repo+number: the stream's issue-record id wins over the pull-record id.
  for (const deep of deepPulls) {
    const key = pullKey(deep.repo, deep.number);
    const idx = pullRequests.findIndex((p) => pullKey(p.repo, p.number) === key);
    if (idx >= 0) pullRequests[idx] = { ...deep, id: pullRequests[idx].id };
    else pullRequests.push(deep);
  }

  return {
    mode,
    issues,
    pullRequests,
    cursor: {
      ...emptyGitHubCursor(),
      assigned: assigned.cursor,
      created: created.cursor,
      lastPolledAt: new Date().toISOString(),
    },
    rateLimit: created.rateLimit ?? assigned.rateLimit,
  };
}
