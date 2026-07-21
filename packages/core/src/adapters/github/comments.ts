import { GITHUB_API_BASE_URL, type Issue } from "@skipper/shared";
import { drainLinkPages } from "../http";
import { githubGet } from "./client";
import type { IssueComment } from "../types";
import type { GitHubTokenProvider } from "./types";

interface GitHubCommentPayload {
  user?: { login: string } | null;
  body?: string | null;
  created_at: string;
}

/** Comments on one GitHub issue, ascending chronological (#144). GitHub returns
 *  them oldest-first, so no re-sort. ApiError propagates — the caller degrades. */
export async function fetchGitHubComments(
  issue: Issue,
  getToken: GitHubTokenProvider,
  baseUrl?: string,
): Promise<IssueComment[]> {
  if (!issue.repo || issue.number == null) return [];
  const base = baseUrl ?? GITHUB_API_BASE_URL;
  const payloads = await drainLinkPages<GitHubCommentPayload>(
    `${base}/repos/${issue.repo.owner}/${issue.repo.name}/issues/${issue.number}/comments?per_page=100`,
    (url) => githubGet<GitHubCommentPayload[]>(url, getToken),
  );
  return payloads.map((c) => ({
    author: c.user?.login ?? "unknown",
    body: c.body ?? "",
    createdAt: c.created_at,
  }));
}
