import { BITBUCKET_BASE_URL } from "@skipper/shared";
import type { RepoRef } from "@skipper/shared";
import { ApiError, type CodeHost } from "../types";
import { ciStatusFromStatuses, deriveBitbucketReviewDecision, mapCommentFeedback } from "./map";
import {
  createPullRequest,
  fetchCommitStatuses,
  fetchFailingChecks,
  fetchPrComments,
  fetchPrParticipants,
  findOpenPrByHead,
} from "./prs";

const HOST = "bitbucket.org";

/** Parses https/ssh/scp Bitbucket remotes into workspace/repo; null unless it is
 *  bitbucket.org with exactly two path segments. Bitbucket's default HTTPS clone URL
 *  carries the username (https://user@bitbucket.org/ws/repo.git), hence the optional
 *  userinfo in the https pattern. */
function parseBitbucketOrigin(remoteUrl: string): RepoRef | null {
  const trimmed = remoteUrl.trim();
  let path: string | null = null;
  const httpsMatch = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed);
  if (httpsMatch && httpsMatch[1].toLowerCase() === HOST) {
    path = httpsMatch[2];
  } else {
    const sshMatch = /^(?:ssh:\/\/)?[^@]+@([^/:]+)[/:](.+)$/i.exec(trimmed);
    if (sshMatch && sshMatch[1].toLowerCase() === HOST) path = sshMatch[2];
  }
  if (path == null) return null;
  path = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  return { owner: segments[0], name: segments[1] };
}

export const bitbucketCodeHost: CodeHost = {
  id: "bitbucket",
  authProvider: "bitbucket",
  supportsDraft: false,
  createPr: async (repo, params, getToken) => {
    try {
      return await createPullRequest(repo, params, getToken);
    } catch (err) {
      // Bitbucket rejects a duplicate PR for this source branch with 400 (plain
      // validation is 400 too) or 409 — the lookup is the actual guard: adopt the
      // open PR for this head, else rethrow the original error. Mirrors GitLab.
      if (err instanceof ApiError && (err.status === 400 || err.status === 409)) {
        const open = await findOpenPrByHead(repo, params.head, getToken);
        if (open) return { ...open, existing: true };
      }
      throw err;
    }
  },
  findOpenPrByHead: (repo, headRef, getToken) => findOpenPrByHead(repo, headRef, getToken),
  fetchReviews: async (repo, number, getToken, prAuthor) => {
    const [participants, comments] = await Promise.all([
      fetchPrParticipants(repo, number, getToken),
      fetchPrComments(repo, number, getToken),
    ]);
    return {
      decision: deriveBitbucketReviewDecision(participants, prAuthor),
      comments: mapCommentFeedback(comments, repo, number, prAuthor),
    };
  },
  fetchCiStatus: async (repo, sha, getToken) => {
    const statuses = await fetchCommitStatuses(repo, sha, getToken);
    return ciStatusFromStatuses(statuses.map((s) => s.state));
  },
  fetchFailingChecks: (repo, sha, getToken) => fetchFailingChecks(repo, sha, getToken),
  // Bitbucket has no PR-body issue-closing keyword; real Jira linkage rides the
  // issue key in the branch name, so this is a plain human-readable reference.
  linkIssueText: (key) => `Refs ${key}`,
  pushCredentials: (token) => ({ username: "x-token-auth", password: token }),
  cloneUrl: (repo) => `${BITBUCKET_BASE_URL}/${repo.owner}/${repo.name}.git`,
  parseOrigin: (remoteUrl) => parseBitbucketOrigin(remoteUrl),
};
