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

export const githubCodeHost: CodeHost = {
  platform: "github",
  authProvider: "github",
  createPr: async (repo, params, getToken) => {
    try {
      return await createPullRequest(repo, params, getToken);
    } catch (err) {
      // 422 = a PR for this head already exists (GitHub convention) — adopt it.
      if (err instanceof ApiError && err.status === 422) {
        const open = await findOpenPullByHead(repo, params.head, getToken);
        if (open) return { ...open, existing: true };
      }
      throw err;
    }
  },
  findOpenPrByHead: (repo, headRef, getToken) => findOpenPullByHead(repo, headRef, getToken),
  fetchReviews: async (repo, number, getToken, prAuthor) => {
    const [reviews, comments] = await Promise.all([
      fetchPullReviews(repo, number, getToken),
      fetchPullReviewComments(repo, number, getToken),
    ]);
    return {
      decision: deriveReviewDecision(reviews, prAuthor),
      comments: mapReviewFeedback(reviews, comments, prAuthor),
    };
  },
  fetchCiStatus: (repo, sha, getToken) => fetchCiStatus(repo, sha, getToken),
  fetchFailingChecks: (repo, sha, getToken) => fetchFailingChecks(repo, sha, getToken),
  linkIssueText: (issueNumber) => `Closes #${issueNumber}`,
  pushCredentials: (token) => ({ username: "x-access-token", password: token }),
};
