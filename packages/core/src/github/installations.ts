import { GITHUB_API_BASE_URL } from "@nestbrain/shared";
import { githubGet, type GitHubResponse } from "./client";
import type { GitHubTokenProvider } from "./types";

// GitHub App installations visible to the user token (#15). User-to-server
// tokens only see private repos where the App is installed, so zero
// installations with a valid token means an empty inbox — the caller surfaces
// the install hint instead.

export interface InstallationRepo {
  owner: string;
  name: string;
  private: boolean;
}

export interface InstallationsResult {
  installationCount: number;
  /** Slug of the GitHub App, from the first installation (absent when count = 0). */
  appSlug?: string;
  repos: InstallationRepo[];
}

interface InstallationPayload {
  id: number;
  app_slug?: string;
}

interface InstallationRepoPayload {
  name: string;
  private: boolean;
  owner: { login: string };
}

async function walkPages<T>(
  firstUrl: string,
  getToken: GitHubTokenProvider,
  pick: (body: unknown) => T[],
): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = firstUrl;
  while (url) {
    const res: GitHubResponse<unknown> = await githubGet<unknown>(url, getToken);
    if (res.body !== undefined) out.push(...pick(res.body));
    url = res.nextUrl;
  }
  return out;
}

export async function listUserInstallationRepos(
  getToken: GitHubTokenProvider,
): Promise<InstallationsResult> {
  const installations = await walkPages<InstallationPayload>(
    `${GITHUB_API_BASE_URL}/user/installations?per_page=100`,
    getToken,
    (body) => (body as { installations?: InstallationPayload[] }).installations ?? [],
  );

  const repos: InstallationRepo[] = [];
  const seen = new Set<string>();
  for (const installation of installations) {
    const payloads = await walkPages<InstallationRepoPayload>(
      `${GITHUB_API_BASE_URL}/user/installations/${installation.id}/repositories?per_page=100`,
      getToken,
      (body) => (body as { repositories?: InstallationRepoPayload[] }).repositories ?? [],
    );
    for (const repo of payloads) {
      const key = `${repo.owner.login.toLowerCase()}/${repo.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push({ owner: repo.owner.login, name: repo.name, private: repo.private });
    }
  }

  return {
    installationCount: installations.length,
    appSlug: installations.find((i) => i.app_slug)?.app_slug,
    repos,
  };
}
