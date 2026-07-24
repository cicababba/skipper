import type { Issue } from "@skipper/shared";
import { drainLinkPages } from "../http";
import { gitlabApiBase, gitlabGet } from "./client";
import type { IssueComment } from "../types";
import type { GitLabTokenProvider } from "./types";

interface GitLabNotePayload {
  author?: { username: string } | null;
  body?: string | null;
  created_at: string;
  system?: boolean;
}

/** Comments (notes) on one GitLab issue, ascending chronological (#144). System
 *  notes (label changes, mentions, etc.) are skipped. ApiError propagates. */
export async function fetchGitLabComments(
  issue: Issue,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<IssueComment[]> {
  if (issue.number == null || !issue.sourceRef.project) return [];
  const project = encodeURIComponent(issue.sourceRef.project);
  const notes = await drainLinkPages<GitLabNotePayload>(
    `${gitlabApiBase(baseUrl)}/projects/${project}/issues/${issue.number}/notes?sort=asc&order_by=created_at&per_page=100`,
    (url) => gitlabGet<GitLabNotePayload[]>(url, getToken),
  );
  return notes
    .filter((n) => !n.system)
    .map((n) => ({
      author: n.author?.username ?? "unknown",
      body: n.body ?? "",
      createdAt: n.created_at,
    }));
}
