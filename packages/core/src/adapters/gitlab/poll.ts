import type { Issue, PullRequest } from "@skipper/shared";
import { gitlabApiBase, gitlabGet } from "./client";
import {
  applyMrDetails,
  mapIssue,
  mapMergeRequest,
  type GitLabApprovalsPayload,
  type GitLabIssuePayload,
  type GitLabMrDetailPayload,
  type GitLabMrPayload,
} from "./map";
import { ApiError } from "../types";
import {
  asGitLabCursor,
  emptyGitLabCursor,
  type GitLabAccountCursor,
  type GitLabPollOptions,
  type GitLabPollResult,
  type GitLabRateLimit,
  type GitLabStreamCursor,
  type GitLabTokenProvider,
} from "./types";

// updated_after overlap absorbing clock skew between GitLab servers; duplicates
// are harmless because consumers upsert by id.
const SINCE_OVERLAP_MS = 60_000;
const DEEP_HYDRATION_CAP = 20;

interface StreamResult<T> {
  payloads: T[];
  cursor: GitLabStreamCursor;
  rateLimit?: GitLabRateLimit;
}

async function walkStream<T extends { updated_at: string }>(
  path: "issues" | "merge_requests",
  scope: string,
  getToken: GitLabTokenProvider,
  cursor: GitLabStreamCursor | undefined,
  onProgress?: (message: string) => void,
  baseUrl?: string,
): Promise<StreamResult<T>> {
  const params = new URLSearchParams({ scope, per_page: "100" });
  if (cursor?.updatedAfter) {
    // Delta: omit `state` so closures/merges arrive too; scope by updated_after.
    params.set("updated_after", cursor.updatedAfter);
  } else {
    params.set("state", "opened");
  }
  const pageOneUrl = `${gitlabApiBase(baseUrl)}/${path}?${params.toString()}`;

  const payloads: T[] = [];
  let rateLimit: GitLabRateLimit | undefined;

  const first = await gitlabGet<T[]>(pageOneUrl, getToken);
  rateLimit = first.rateLimit ?? rateLimit;
  payloads.push(...(first.body ?? []));

  let nextUrl = first.nextUrl;
  while (nextUrl) {
    const page = await gitlabGet<T[]>(nextUrl, getToken);
    rateLimit = page.rateLimit ?? rateLimit;
    payloads.push(...(page.body ?? []));
    nextUrl = page.nextUrl;
  }

  let updatedAfter = cursor?.updatedAfter;
  if (payloads.length > 0) {
    const maxUpdated = Math.max(...payloads.map((p) => Date.parse(p.updated_at)));
    updatedAfter = new Date(maxUpdated - SINCE_OVERLAP_MS).toISOString();
  }
  onProgress?.(`${path}: ${payloads.length} items`);
  return { payloads, cursor: { updatedAfter }, rateLimit };
}

function mrKey(repo: { owner: string; name: string }, number: number): string {
  return `${repo.owner}/${repo.name}!${number}`;
}

// Tracked MRs (#11): approvals and CI never bump updated_at, so these are fetched
// unconditionally each poll — detail (head_pipeline) then approvals while open.
async function hydrateTrackedMrs(
  targets: NonNullable<GitLabPollOptions["deepHydrate"]>,
  accountId: string,
  getToken: GitLabTokenProvider,
  onProgress?: (message: string) => void,
  baseUrl?: string,
): Promise<PullRequest[]> {
  if (targets.length > DEEP_HYDRATION_CAP) {
    onProgress?.(`deep hydration capped at ${DEEP_HYDRATION_CAP} of ${targets.length} tracked MRs`);
  }
  const out: PullRequest[] = [];
  for (const target of targets.slice(0, DEEP_HYDRATION_CAP)) {
    const projectPath = encodeURIComponent(`${target.owner}/${target.name}`);
    const mrUrl = `${gitlabApiBase(baseUrl)}/projects/${projectPath}/merge_requests/${target.number}`;
    const label = `${target.owner}/${target.name}!${target.number}`;
    try {
      const detail = await gitlabGet<GitLabMrDetailPayload>(mrUrl, getToken);
      if (!detail.body) continue;
      const mr = mapMergeRequest(detail.body, accountId);
      if (mr.state !== "open") {
        out.push(mr);
        continue;
      }
      const approvals = await gitlabGet<GitLabApprovalsPayload>(`${mrUrl}/approvals`, getToken);
      out.push(applyMrDetails(mr, detail.body, approvals.body));
    } catch (err) {
      // Non-fatal: the next poll retries; reconcile just sees no fresh evidence.
      onProgress?.(`deep hydration failed for ${label}: ${String(err)}`);
    }
  }
  return out;
}

export async function pollGitLabAccount(options: GitLabPollOptions): Promise<GitLabPollResult> {
  const cursor = asGitLabCursor(options.cursor);
  try {
    return await runPoll(options, cursor);
  } catch (err) {
    // GitLab rejects a malformed updated_after with 400 — recover with a full walk.
    if (cursor && err instanceof ApiError && err.status === 400) {
      options.onProgress?.("cursor rejected (400) — falling back to full walk");
      return runPoll(options, undefined);
    }
    throw err;
  }
}

async function runPoll(
  options: GitLabPollOptions,
  cursor: GitLabAccountCursor | undefined,
): Promise<GitLabPollResult> {
  const { accountId, getToken, onProgress, baseUrl } = options;
  const mode = cursor ? "delta" : "full";

  const issueStream = await walkStream<GitLabIssuePayload>(
    "issues",
    "assigned_to_me",
    getToken,
    cursor?.issues,
    onProgress,
    baseUrl,
  );
  const mrStream = await walkStream<GitLabMrPayload>(
    "merge_requests",
    "created_by_me",
    getToken,
    cursor?.mergeRequests,
    onProgress,
    baseUrl,
  );

  const issues: Issue[] = issueStream.payloads.map((p) => mapIssue(p, accountId));
  const pullRequests: PullRequest[] = mrStream.payloads.map((p) => mapMergeRequest(p, accountId));

  const deepMrs = await hydrateTrackedMrs(
    options.deepHydrate ?? [],
    accountId,
    getToken,
    onProgress,
    baseUrl,
  );

  // Merge by repo+number: the stream's list-record id wins over the detail-record id.
  for (const deep of deepMrs) {
    const key = mrKey(deep.repo, deep.number);
    const idx = pullRequests.findIndex((p) => mrKey(p.repo, p.number) === key);
    if (idx >= 0) pullRequests[idx] = { ...deep, id: pullRequests[idx].id };
    else pullRequests.push(deep);
  }

  return {
    mode,
    issues,
    pullRequests,
    cursor: {
      ...emptyGitLabCursor(),
      issues: issueStream.cursor,
      mergeRequests: mrStream.cursor,
      lastPolledAt: new Date().toISOString(),
    },
    rateLimit: mrStream.rateLimit ?? issueStream.rateLimit,
  };
}
