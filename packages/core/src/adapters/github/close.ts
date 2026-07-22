import { GITHUB_API_BASE_URL, type Issue } from "@skipper/shared";
import { githubPatch } from "./client";
import type { GitHubTokenProvider } from "./types";

/** Closes a GitHub issue on the tracker (#132). state_reason "completed" mirrors
 *  the UI's "Close as completed". ApiError propagates (e.g. 403 when the App lacks
 *  Issues: write). */
export async function closeGitHubIssue(
  issue: Issue,
  getToken: GitHubTokenProvider,
  baseUrl?: string,
): Promise<void> {
  if (!issue.repo || issue.number == null) {
    throw new Error("cannot close a GitHub issue without repo and number");
  }
  const base = baseUrl ?? GITHUB_API_BASE_URL;
  await githubPatch(
    `${base}/repos/${issue.repo.owner}/${issue.repo.name}/issues/${issue.number}`,
    getToken,
    { state: "closed", state_reason: "completed" },
  );
}
