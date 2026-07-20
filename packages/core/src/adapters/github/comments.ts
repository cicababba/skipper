import { GITHUB_API_BASE_URL, type Issue } from "@skipper/shared";
import { githubGet, type GitHubResponse } from "./client";
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
  const out: IssueComment[] = [];
  let url: string | undefined = `${base}/repos/${issue.repo.owner}/${issue.repo.name}/issues/${issue.number}/comments?per_page=100`;
  while (url) {
    const res: GitHubResponse<GitHubCommentPayload[]> = await githubGet(url, getToken);
    for (const c of res.body ?? []) {
      out.push({ author: c.user?.login ?? "unknown", body: c.body ?? "", createdAt: c.created_at });
    }
    url = res.nextUrl;
  }
  return out;
}
