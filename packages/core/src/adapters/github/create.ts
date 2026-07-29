import { GITHUB_API_BASE_URL, type Issue } from "@skipper/shared";
import type { CreateIssueParams } from "../types";
import { githubPost } from "./client";
import { mapIssue, type GitHubIssuePayload } from "./map";
import type { GitHubTokenProvider } from "./types";

/** Creates a GitHub issue on the tracker (#134) and returns it fully mapped, so the
 *  caller can inject it into the manifest without a re-poll. body/labels are omitted
 *  from the request when absent. ApiError propagates (e.g. 403 when the App lacks
 *  Issues: write). */
export async function createGitHubIssue(
  params: CreateIssueParams,
  getToken: GitHubTokenProvider,
  baseUrl?: string,
): Promise<Issue> {
  const base = baseUrl ?? GITHUB_API_BASE_URL;
  const res = await githubPost<GitHubIssuePayload>(
    `${base}/repos/${params.repo.owner}/${params.repo.name}/issues`,
    getToken,
    {
      title: params.title,
      ...(params.body !== undefined && { body: params.body }),
      ...(params.labels !== undefined && { labels: params.labels }),
    },
  );
  return mapIssue(res.body!, params.accountId);
}
