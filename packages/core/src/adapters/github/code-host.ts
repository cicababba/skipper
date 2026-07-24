import { ApiError, type CodeHost } from "../types";
import {
  createPullRequest,
  deriveReviewDecision,
  fetchCiStatus,
  fetchFailingChecks,
  fetchPullReviewComments,
  fetchPullReviews,
  findOpenPullByHead,
  mapReviewFeedback,
} from "./pulls";

// Matches https, ssh and scp-like origins: https://github.com/o/r(.git), git@github.com:o/r(.git).
const ORIGIN_RE = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i;

export const githubCodeHost: CodeHost = {
  id: "github",
  authProvider: "github",
  supportsDraft: true,
  createPr: async (repo, params, getToken, baseUrl) => {
    try {
      return await createPullRequest(repo, params, getToken, baseUrl);
    } catch (err) {
      // 422 = a PR for this head already exists (GitHub convention) — adopt it.
      if (err instanceof ApiError && err.status === 422) {
        const open = await findOpenPullByHead(repo, params.head, getToken, baseUrl);
        if (open) return { ...open, existing: true };
      }
      throw err;
    }
  },
  findOpenPrByHead: (repo, headRef, getToken, baseUrl) =>
    findOpenPullByHead(repo, headRef, getToken, baseUrl),
  fetchReviews: async (repo, number, getToken, prAuthor, baseUrl) => {
    const [reviews, comments] = await Promise.all([
      fetchPullReviews(repo, number, getToken, baseUrl),
      fetchPullReviewComments(repo, number, getToken, baseUrl),
    ]);
    return {
      decision: deriveReviewDecision(reviews, prAuthor),
      comments: mapReviewFeedback(reviews, comments, prAuthor),
    };
  },
  fetchCiStatus: (repo, sha, getToken, baseUrl) => fetchCiStatus(repo, sha, getToken, baseUrl),
  fetchFailingChecks: (repo, sha, getToken, baseUrl) =>
    fetchFailingChecks(repo, sha, getToken, baseUrl),
  linkIssueText: (key) => `Closes #${key}`,
  pushCredentials: (token) => ({ username: "x-access-token", password: token }),
  cloneUrl: (repo) => `https://github.com/${repo.owner}/${repo.name}.git`,
  parseOrigin: (remoteUrl) => {
    const match = ORIGIN_RE.exec(remoteUrl.trim());
    return match ? { owner: match[1], name: match[2] } : null;
  },
};
