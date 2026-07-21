import type { RepoRef } from "@skipper/shared";
import { drainLinkPages } from "../http";
import { gitlabApiBase, gitlabGet } from "./client";
import { repoRefFromPath } from "./map";
import type { GitLabTokenProvider } from "./types";

interface GitLabProjectPayload {
  path_with_namespace: string;
  visibility?: string;
}

export interface MembershipProject {
  repo: RepoRef;
  private: boolean;
}

/** Projects the account is a member of — the GitLab equivalent of the GitHub
 *  App installation repos that seed the follow-repos picker. */
export async function listMembershipProjects(
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<MembershipProject[]> {
  const projects = await drainLinkPages<GitLabProjectPayload>(
    `${gitlabApiBase(baseUrl)}/projects?membership=true&archived=false&per_page=100`,
    (url) => gitlabGet<GitLabProjectPayload[]>(url, getToken),
  );
  return projects.map((project) => ({
    repo: repoRefFromPath(project.path_with_namespace),
    private: project.visibility !== "public",
  }));
}
