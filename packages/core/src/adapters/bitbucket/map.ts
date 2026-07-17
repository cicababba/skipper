import { BITBUCKET_BASE_URL } from "@skipper/shared";
import type { PrReviewComment, PullRequest, RepoRef } from "@skipper/shared";

export interface BitbucketUser {
  nickname?: string;
  uuid?: string;
  display_name?: string;
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
