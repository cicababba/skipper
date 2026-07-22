import type { Issue } from "@skipper/shared";
import { gitlabApiBase, gitlabPut } from "./client";
import type { GitLabTokenProvider } from "./types";

/** Closes a GitLab issue on the tracker (#132). issue.number is the project-scoped
 *  iid. ApiError propagates. */
export async function closeGitLabIssue(
  issue: Issue,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<void> {
  if (issue.number == null || !issue.sourceRef.project) {
    throw new Error("cannot close a GitLab issue without iid and project");
  }
  const project = encodeURIComponent(issue.sourceRef.project);
  await gitlabPut(
    `${gitlabApiBase(baseUrl)}/projects/${project}/issues/${issue.number}`,
    getToken,
    { state_event: "close" },
  );
}
