import { GITLAB_BASE_URL } from "@skipper/shared";
import type { RepoRef } from "@skipper/shared";
import { ApiError, type CodeHost } from "../types";
import { deriveGitLabReviewDecision } from "./map";
import {
  createMergeRequest,
  fetchCiStatus,
  fetchFailingChecks,
  fetchMrApprovals,
  fetchMrDiscussions,
  findOpenMrByHead,
  hasUnresolvedThreads,
  mapDiscussionFeedback,
} from "./mrs";

/** Parses an https/ssh/scp remote against the instance host (from baseUrl, else
 *  gitlab.com), tolerating a subpath install and nested-group owners. */
function parseGitLabOrigin(remoteUrl: string, baseUrl?: string): RepoRef | null {
  const trimmed = remoteUrl.trim();
  let instance: URL;
  try {
    instance = new URL(baseUrl ?? GITLAB_BASE_URL);
  } catch {
    return null;
  }
  const host = instance.host.toLowerCase();
  const basePath = instance.pathname.replace(/^\/+|\/+$/g, ""); // subpath install, e.g. "gitlab"

  let path: string | null = null;
  const httpsMatch = /^https?:\/\/([^/]+)\/(.+)$/i.exec(trimmed);
  if (httpsMatch && httpsMatch[1].toLowerCase() === host) {
    path = httpsMatch[2];
  } else {
    // ssh://git@<host>/<path> or scp-like git@<host>:<path>
    const sshMatch = /^(?:ssh:\/\/)?[^@]+@([^/:]+)[/:](.+)$/i.exec(trimmed);
    if (sshMatch && sshMatch[1].toLowerCase() === host) path = sshMatch[2];
  }
  if (path == null) return null;

  path = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (basePath) {
    const prefix = `${basePath}/`.toLowerCase();
    if (path.toLowerCase().startsWith(prefix)) path = path.slice(prefix.length);
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const name = segments.pop()!;
  return { owner: segments.join("/"), name };
}

export const gitlabCodeHost: CodeHost = {
  id: "gitlab",
  authProvider: "gitlab",
  supportsDraft: true,
  createPr: async (repo, params, getToken, baseUrl) => {
    try {
      return await createMergeRequest(repo, params, getToken, baseUrl);
    } catch (err) {
      // 409 = an open MR for this source branch already exists (GitLab convention) — adopt it.
      if (err instanceof ApiError && err.status === 409) {
        const open = await findOpenMrByHead(repo, params.head, getToken, baseUrl);
        if (open) return { ...open, existing: true };
      }
      throw err;
    }
  },
  findOpenPrByHead: (repo, headRef, getToken, baseUrl) =>
    findOpenMrByHead(repo, headRef, getToken, baseUrl),
  fetchReviews: async (repo, number, getToken, prAuthor, baseUrl) => {
    const [approvals, discussions] = await Promise.all([
      fetchMrApprovals(repo, number, getToken, baseUrl),
      fetchMrDiscussions(repo, number, getToken, baseUrl),
    ]);
    return {
      decision: deriveGitLabReviewDecision(approvals, hasUnresolvedThreads(discussions)),
      comments: mapDiscussionFeedback(discussions, repo, number, prAuthor, baseUrl),
    };
  },
  fetchCiStatus: (repo, sha, getToken, baseUrl) => fetchCiStatus(repo, sha, getToken, baseUrl),
  fetchFailingChecks: (repo, sha, getToken, baseUrl) =>
    fetchFailingChecks(repo, sha, getToken, baseUrl),
  linkIssueText: (key) => `Closes #${key}`,
  linkIssueUrlText: (url) => `Closes ${url}`,
  pushCredentials: (token) => ({ username: "oauth2", password: token }),
  cloneUrl: (repo, baseUrl) => `${baseUrl ?? GITLAB_BASE_URL}/${repo.owner}/${repo.name}.git`,
  parseOrigin: (remoteUrl, baseUrl) => parseGitLabOrigin(remoteUrl, baseUrl),
};
