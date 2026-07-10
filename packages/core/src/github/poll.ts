import { GITHUB_API_BASE_URL } from "@nestbrain/shared";
import type { Issue, PullRequest } from "@nestbrain/shared";
import { githubGet } from "./client";
import { applyPullDetails, mapIssue, mapPullFromIssue, type GitHubIssuePayload, type GitHubPullPayload } from "./map";
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

async function hydratePulls(
  pulls: PullRequest[],
  getToken: GitHubTokenProvider,
  onProgress?: (message: string) => void,
): Promise<PullRequest[]> {
  const out: PullRequest[] = [];
  let hydrated = 0;
  for (const pr of pulls) {
    if (pr.state !== "open" || hydrated >= HYDRATION_CAP) {
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

  const pullRequests = await hydratePulls(listPulls, getToken, onProgress);

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
