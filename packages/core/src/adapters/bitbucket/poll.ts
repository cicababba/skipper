import { BITBUCKET_API_BASE_URL, type Issue, type PullRequest, type RepoRef } from "@skipper/shared";
import { ApiError } from "../types";
import { bitbucketGet, bitbucketPaginate } from "./client";
import {
  ciStatusFromStatuses,
  deriveBitbucketReviewDecision,
  mapBitbucketIssue,
  mapBitbucketPullRequest,
  type BitbucketIssuePayload,
  type BitbucketPrPayload,
  type BitbucketUser,
} from "./map";
import { bbqlString, fetchCommitStatuses, fetchPrParticipants, repoApiUrl } from "./prs";
import {
  asBitbucketCursor,
  emptyBitbucketCursor,
  type BitbucketAccountCursor,
  type BitbucketPollOptions,
  type BitbucketPollResult,
  type BitbucketStreamCursor,
  type BitbucketTokenProvider,
} from "./types";

// updated_on overlap absorbing clock skew; duplicates are harmless because
// consumers upsert by id.
const SINCE_OVERLAP_MS = 60_000;
const DEEP_HYDRATION_CAP = 20;
// Bitbucket has no cross-repo issue search, so issues cost one request per repo —
// the walk is capped to keep a large membership from stalling the poll.
const REPO_CAP = 50;
const PR_PAGE_SIZE = 50;
const REPO_PAGE_SIZE = 100;
const ISSUE_PAGE_SIZE = 50;

const OPEN_ISSUE_STATES = ["new", "open", "on hold"];
const PR_STATES = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];

interface RepositoryPayload {
  full_name?: string;
}

function repoFromFullName(fullName: string): RepoRef {
  const slash = fullName.indexOf("/");
  return slash <= 0
    ? { owner: fullName, name: "" }
    : { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/** Next stream cursor from every payload the walk saw — computed before any
 *  client-side filtering so the window advances even when nothing is kept. */
function advanceCursor(
  payloads: Array<{ updated_on?: string }>,
  previous: BitbucketStreamCursor | undefined,
): BitbucketStreamCursor {
  const stamps = payloads
    .map((p) => Date.parse(p.updated_on ?? ""))
    .filter((n) => Number.isFinite(n));
  if (stamps.length === 0) return { updatedAfter: previous?.updatedAfter };
  return { updatedAfter: new Date(Math.max(...stamps) - SINCE_OVERLAP_MS).toISOString() };
}

async function walkPullRequests(
  uuid: string,
  getToken: BitbucketTokenProvider,
  cursor: BitbucketStreamCursor | undefined,
  onProgress?: (message: string) => void,
): Promise<BitbucketPrPayload[]> {
  const states = PR_STATES.map((s) => `state = ${bbqlString(s)}`).join(" OR ");
  const q = cursor?.updatedAfter
    ? // Delta: enumerate every state so merges/declines arrive too.
      `updated_on > ${bbqlString(cursor.updatedAfter)} AND (${states})`
    : `state = ${bbqlString("OPEN")}`;
  const params = new URLSearchParams({ q, pagelen: String(PR_PAGE_SIZE) });
  const payloads = await bitbucketPaginate<BitbucketPrPayload>(
    `${BITBUCKET_API_BASE_URL}/pullrequests/${encodeURIComponent(uuid)}?${params.toString()}`,
    getToken,
  );
  onProgress?.(`pull requests: ${payloads.length} items`);
  return payloads;
}

async function listIssueRepos(
  getToken: BitbucketTokenProvider,
  onProgress?: (message: string) => void,
): Promise<string[]> {
  const params = new URLSearchParams({
    role: "member",
    q: "has_issues = true",
    pagelen: String(REPO_PAGE_SIZE),
  });
  const repos = await bitbucketPaginate<RepositoryPayload>(
    `${BITBUCKET_API_BASE_URL}/repositories?${params.toString()}`,
    getToken,
  );
  const fullNames = repos.map((r) => r.full_name).filter((n): n is string => !!n);
  if (fullNames.length > REPO_CAP) {
    onProgress?.(`issue walk capped at ${REPO_CAP} of ${fullNames.length} repos with issues`);
  }
  return fullNames.slice(0, REPO_CAP);
}

async function walkIssues(
  getToken: BitbucketTokenProvider,
  cursor: BitbucketStreamCursor | undefined,
  onProgress?: (message: string) => void,
): Promise<BitbucketIssuePayload[]> {
  const openStates = OPEN_ISSUE_STATES.map((s) => `state = ${bbqlString(s)}`).join(" OR ");
  const q = cursor?.updatedAfter
    ? // Delta: no state filter so closures arrive and reconcile can close the item.
      `updated_on > ${bbqlString(cursor.updatedAfter)}`
    : `(${openStates})`;
  const out: BitbucketIssuePayload[] = [];
  for (const fullName of await listIssueRepos(getToken, onProgress)) {
    const params = new URLSearchParams({ q, pagelen: String(ISSUE_PAGE_SIZE) });
    const payloads = await bitbucketPaginate<BitbucketIssuePayload>(
      `${repoApiUrl(repoFromFullName(fullName))}/issues?${params.toString()}`,
      getToken,
    );
    out.push(...payloads);
  }
  onProgress?.(`issues: ${out.length} items`);
  return out;
}

function prKey(repo: RepoRef, number: number): string {
  return `${repo.owner}/${repo.name}!${number}`;
}

// Tracked PRs (#11): approvals and CI never bump updated_on, so these are fetched
// unconditionally each poll.
async function hydrateTrackedPrs(
  targets: NonNullable<BitbucketPollOptions["deepHydrate"]>,
  accountId: string,
  getToken: BitbucketTokenProvider,
  onProgress?: (message: string) => void,
): Promise<PullRequest[]> {
  if (targets.length > DEEP_HYDRATION_CAP) {
    onProgress?.(`deep hydration capped at ${DEEP_HYDRATION_CAP} of ${targets.length} tracked PRs`);
  }
  const out: PullRequest[] = [];
  for (const target of targets.slice(0, DEEP_HYDRATION_CAP)) {
    const repo: RepoRef = { owner: target.owner, name: target.name };
    const label = prKey(repo, target.number);
    try {
      const detail = await bitbucketGet<BitbucketPrPayload>(
        `${repoApiUrl(repo)}/pullrequests/${target.number}`,
        getToken,
      );
      const pr = mapBitbucketPullRequest(detail, accountId);
      if (pr.state !== "open") {
        out.push(pr);
        continue;
      }
      const participants = await fetchPrParticipants(repo, target.number, getToken);
      const statuses = pr.headSha
        ? await fetchCommitStatuses(repo, pr.headSha, getToken)
        : [];
      out.push({
        ...pr,
        reviewDecision: deriveBitbucketReviewDecision(participants, pr.author),
        ciStatus: ciStatusFromStatuses(statuses.map((s) => s.state)),
      });
    } catch (err) {
      // Non-fatal: the next poll retries; reconcile just sees no fresh evidence.
      onProgress?.(`deep hydration failed for ${label}: ${String(err)}`);
    }
  }
  return out;
}

export async function pollBitbucketAccount(
  options: BitbucketPollOptions,
): Promise<BitbucketPollResult> {
  const cursor = asBitbucketCursor(options.cursor);
  try {
    return await runPoll(options, cursor);
  } catch (err) {
    // Bitbucket rejects a malformed query with 400 — recover with a full walk.
    if (cursor && err instanceof ApiError && err.status === 400) {
      options.onProgress?.("cursor rejected (400) — falling back to full walk");
      return runPoll(options, undefined);
    }
    throw err;
  }
}

async function runPoll(
  options: BitbucketPollOptions,
  cursor: BitbucketAccountCursor | undefined,
): Promise<BitbucketPollResult> {
  const { accountId, getToken, onProgress } = options;
  const mode = cursor ? "delta" : "full";

  const me = await bitbucketGet<BitbucketUser>(`${BITBUCKET_API_BASE_URL}/user`, getToken);

  const prPayloads = await walkPullRequests(me.uuid ?? "", getToken, cursor?.pullRequests, onProgress);
  const issuePayloads = await walkIssues(getToken, cursor?.issues, onProgress);

  // Bitbucket's issue search has no "assigned to me" operator, so the account's
  // own issues are selected here — the cursor still advances over everything seen.
  const mine = issuePayloads.filter((p) => p.assignee?.uuid && p.assignee.uuid === me.uuid);

  const issues: Issue[] = mine.map((p) => mapBitbucketIssue(p, accountId));
  const pullRequests: PullRequest[] = prPayloads.map((p) => mapBitbucketPullRequest(p, accountId));

  const deepPrs = await hydrateTrackedPrs(
    options.deepHydrate ?? [],
    accountId,
    getToken,
    onProgress,
  );
  for (const deep of deepPrs) {
    const key = prKey(deep.repo, deep.number);
    const idx = pullRequests.findIndex((p) => prKey(p.repo, p.number) === key);
    if (idx >= 0) pullRequests[idx] = { ...deep, id: pullRequests[idx].id };
    else pullRequests.push(deep);
  }

  return {
    mode,
    issues,
    pullRequests,
    cursor: {
      ...emptyBitbucketCursor(),
      issues: advanceCursor(issuePayloads, cursor?.issues),
      pullRequests: advanceCursor(prPayloads, cursor?.pullRequests),
      lastPolledAt: new Date().toISOString(),
    },
  };
}
