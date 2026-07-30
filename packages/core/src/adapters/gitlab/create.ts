import type { Issue } from "@skipper/shared";
import type { CreateIssueParams } from "../types";
import { gitlabApiBase, gitlabGet, gitlabPost } from "./client";
import { mapIssue, type GitLabIssuePayload } from "./map";
import type { GitLabTokenProvider } from "./types";

interface GitLabUserPayload {
  id: number;
  username: string;
}

/** GitLab assigns by numeric user id, so each username costs a lookup. A lookup
 *  that fails or matches nobody drops that assignee rather than failing the
 *  create — an issue on the tracker beats no issue at all. */
async function resolveAssigneeIds(
  usernames: string[],
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<number[]> {
  const ids: number[] = [];
  for (const username of usernames) {
    try {
      const res = await gitlabGet<GitLabUserPayload[]>(
        `${gitlabApiBase(baseUrl)}/users?username=${encodeURIComponent(username)}`,
        getToken,
      );
      const match = (res.body ?? []).find(
        (u) => u.username.toLowerCase() === username.toLowerCase(),
      );
      if (match) ids.push(match.id);
    } catch {
      // lookup failed — create the issue unassigned rather than not at all
    }
  }
  return ids;
}

/** Creates a GitLab issue on the tracker (#274) and returns it fully mapped. The
 *  POST response carries references.full/web_url, so the poll mapper applies
 *  unchanged. ApiError propagates. */
export async function createGitLabIssue(
  params: CreateIssueParams,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<Issue> {
  const project = encodeURIComponent(`${params.repo.owner}/${params.repo.name}`);
  const assigneeIds = params.assignees?.length
    ? await resolveAssigneeIds(params.assignees, getToken, baseUrl)
    : [];
  const res = await gitlabPost<GitLabIssuePayload>(
    `${gitlabApiBase(baseUrl)}/projects/${project}/issues`,
    getToken,
    {
      title: params.title,
      ...(params.body !== undefined && { description: params.body }),
      ...(params.labels !== undefined && { labels: params.labels.join(",") }),
      ...(assigneeIds.length > 0 && { assignee_ids: assigneeIds }),
    },
  );
  return mapIssue(res.body!, params.accountId);
}
