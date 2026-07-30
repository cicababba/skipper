import { BITBUCKET_BASE_URL } from "@skipper/shared";
import type { Issue, PrReviewComment, PullRequest, RepoRef } from "@skipper/shared";

export interface BitbucketUser {
  nickname?: string;
  uuid?: string;
  display_name?: string;
}

interface BitbucketRepositoryRef {
  full_name?: string;
}

export interface BitbucketIssuePayload {
  id: number;
  title?: string;
  content?: { raw?: string } | null;
  /** new | open | on hold | resolved | invalid | duplicate | wontfix | closed */
  state?: string;
  reporter?: BitbucketUser | null;
  assignee?: BitbucketUser | null;
  repository?: BitbucketRepositoryRef | null;
  links?: { html?: { href?: string } };
  created_on?: string;
  updated_on?: string;
}

export interface BitbucketPrPayload {
  id: number;
  title?: string;
  description?: string | null;
  /** OPEN | MERGED | DECLINED | SUPERSEDED */
  state?: string;
  draft?: boolean;
  author?: BitbucketUser | null;
  source?: {
    branch?: { name?: string };
    commit?: { hash?: string };
    repository?: BitbucketRepositoryRef | null;
  } | null;
  destination?: {
    branch?: { name?: string };
    repository?: BitbucketRepositoryRef | null;
  } | null;
  links?: { html?: { href?: string } };
  created_on?: string;
  updated_on?: string;
}

const CLOSED_ISSUE_STATES = new Set(["resolved", "invalid", "duplicate", "wontfix", "closed"]);

/** Bitbucket serves `+00:00`-offset timestamps with microseconds; the orchestrator
 *  sorts updatedAt by string comparison, so normalize to UTC ISO. */
export function toUtcIso(value: string | undefined): string {
  return value ? new Date(Date.parse(value)).toISOString() : new Date(0).toISOString();
}

export function userName(user: BitbucketUser | null | undefined): string | undefined {
  if (!user) return undefined;
  return user.nickname ?? user.display_name ?? user.uuid ?? undefined;
}

function repoFromFullName(fullName: string | undefined): RepoRef {
  const path = fullName ?? "";
  const slash = path.indexOf("/");
  if (slash <= 0) return { owner: path, name: "" };
  return { owner: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** Bitbucket ids are repo-scoped (issue 1 exists in every repo), so the global id
 *  is repo-qualified — `#` for issues, `!` for PRs. */
function globalId(fullName: string, sep: "#" | "!", id: number): string {
  return `bitbucket:${fullName.toLowerCase()}${sep}${id}`;
}

export function mapBitbucketIssue(payload: BitbucketIssuePayload, accountId: string): Issue {
  const fullName = payload.repository?.full_name ?? "";
  const repo = repoFromFullName(fullName);
  const key = String(payload.id);
  const assignee = userName(payload.assignee);
  return {
    id: globalId(fullName, "#", payload.id),
    source: "bitbucket",
    sourceRef: { project: fullName, key },
    codeHost: "bitbucket",
    accountId,
    repo,
    key,
    number: payload.id,
    title: payload.title ?? "",
    body: payload.content?.raw || undefined,
    labels: [],
    assignees: assignee ? [assignee] : [],
    author: userName(payload.reporter),
    url: payload.links?.html?.href ?? `${BITBUCKET_BASE_URL}/${fullName}/issues/${payload.id}`,
    createdAt: toUtcIso(payload.created_on),
    updatedAt: toUtcIso(payload.updated_on),
    kind: "issue",
    state: CLOSED_ISSUE_STATES.has((payload.state ?? "").toLowerCase()) ? "closed" : "open",
  };
}

export function mapBitbucketPullRequest(
  payload: BitbucketPrPayload,
  accountId: string,
): PullRequest {
  const fullName =
    payload.destination?.repository?.full_name ?? payload.source?.repository?.full_name ?? "";
  const repo = repoFromFullName(fullName);
  const key = String(payload.id);
  const merged = payload.state === "MERGED";
  return {
    id: globalId(fullName, "!", payload.id),
    source: "bitbucket",
    sourceRef: { project: fullName, key },
    codeHost: "bitbucket",
    accountId,
    repo,
    key,
    number: payload.id,
    title: payload.title ?? "",
    body: payload.description ?? undefined,
    labels: [],
    assignees: [],
    author: userName(payload.author),
    url:
      payload.links?.html?.href ??
      `${BITBUCKET_BASE_URL}/${fullName}/pull-requests/${payload.id}`,
    createdAt: toUtcIso(payload.created_on),
    updatedAt: toUtcIso(payload.updated_on),
    kind: "pull-request",
    state: payload.state === "OPEN" ? "open" : "closed",
    merged,
    draft: payload.draft ?? false,
    headRef: payload.source?.branch?.name,
    baseRef: payload.destination?.branch?.name,
    headSha: payload.source?.commit?.hash,
  };
}

export interface BitbucketParticipant {
  role?: "REVIEWER" | "PARTICIPANT";
  approved?: boolean;
  state?: "approved" | "changes_requested" | null;
  user?: BitbucketUser;
}

export interface BitbucketCommentPayload {
  id?: number;
  deleted?: boolean;
  pending?: boolean;
  content?: { raw?: string };
  user?: BitbucketUser;
  inline?: { path?: string; to?: number | null; from?: number | null };
  links?: { html?: { href?: string } };
  created_on?: string;
}

export type BitbucketStatusState = "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";

export interface BitbucketStatusPayload {
  key?: string;
  name?: string;
  state?: BitbucketStatusState | string;
  url?: string;
  description?: string;
}

/** Author match is uuid-canonical (nickname is mutable); nothing populates prAuthor
 *  today, so this is defensive. */
function isAuthor(user: BitbucketUser | undefined, prAuthor?: string): boolean {
  if (!prAuthor || !user) return false;
  return user.uuid === prAuthor || user.nickname === prAuthor;
}

/** changes_requested beats an approval (GitHub semantics); any approver — whatever
 *  their role — counts. The PR author's own vote is excluded. */
export function deriveBitbucketReviewDecision(
  participants: BitbucketParticipant[],
  prAuthor?: string,
): NonNullable<PullRequest["reviewDecision"]> {
  const others = participants.filter((p) => !isAuthor(p.user, prAuthor));
  if (others.some((p) => p.state === "changes_requested")) return "changes-requested";
  if (others.some((p) => p.approved === true)) return "approved";
  return "review-required";
}

/** Worst-wins across all commit statuses; an empty or unknown-only set carries no
 *  pass/fail signal (undefined), matching the no-CI convention. */
export function ciStatusFromStatuses(
  states: Array<BitbucketStatusState | string | undefined>,
): PullRequest["ciStatus"] {
  let sawSuccess = false;
  let sawPending = false;
  for (const state of states) {
    if (state === "FAILED" || state === "STOPPED") return "failing";
    if (state === "INPROGRESS") sawPending = true;
    else if (state === "SUCCESSFUL") sawSuccess = true;
  }
  if (sawPending) return "pending";
  if (sawSuccess) return "passing";
  return undefined;
}

/** Human feedback for the fix prompt, minus deleted/pending/empty comments and the
 *  PR author's own. Bitbucket exposes no stable resolved-thread field, so every live
 *  comment is forwarded — the shepherd prompt tolerates the extra context. */
export function mapCommentFeedback(
  comments: BitbucketCommentPayload[],
  repo: RepoRef,
  prId: number,
  prAuthor?: string,
): PrReviewComment[] {
  const out: PrReviewComment[] = [];
  for (const comment of comments) {
    if (comment.deleted || comment.pending) continue;
    if (isAuthor(comment.user, prAuthor)) continue;
    const body = comment.content?.raw?.trim();
    if (!body) continue;
    out.push({
      author: comment.user?.nickname,
      path: comment.inline?.path,
      line: comment.inline?.to ?? comment.inline?.from ?? undefined,
      body,
      url:
        comment.links?.html?.href ??
        `${BITBUCKET_BASE_URL}/${repo.owner}/${repo.name}/pull-requests/${prId}`,
      submittedAt: comment.created_on,
    });
  }
  return out;
}
