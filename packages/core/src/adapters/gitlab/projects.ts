import type { RepoRef } from "@skipper/shared";
import { gitlabApiBase, gitlabGet, type GitLabResponse } from "./client";
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
  const out: MembershipProject[] = [];
  let next: string | undefined =
    `${gitlabApiBase(baseUrl)}/projects?membership=true&archived=false&per_page=100`;
  while (next) {
    const res: GitLabResponse<GitLabProjectPayload[]> = await gitlabGet<GitLabProjectPayload[]>(
      next,
      getToken,
    );
    for (const project of res.body ?? []) {
      out.push({
        repo: repoRefFromPath(project.path_with_namespace),
        private: project.visibility !== "public",
      });
    }
    next = res.nextUrl;
  }
  return out;
}
