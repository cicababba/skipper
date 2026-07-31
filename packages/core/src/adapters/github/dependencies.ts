import { GITHUB_API_BASE_URL, type Issue, type SourceRef } from "@skipper/shared";
import { dedupeRefs, parseBodyDependencies } from "../dependencies";
import { drainLinkPages } from "../http";
import { githubGet } from "./client";
import { parseRepoFromUrl } from "./map";
import { ApiError } from "../types";
import type { GitHubTokenProvider } from "./types";

interface GitHubDependencyPayload {
  number: number;
  repository_url: string;
}

async function fetchNativeDependencies(
  issue: Issue,
  getToken: GitHubTokenProvider,
  baseUrl?: string,
): Promise<SourceRef[]> {
  if (!issue.repo) return [];
  const base = baseUrl ?? GITHUB_API_BASE_URL;
  const payloads = await drainLinkPages<GitHubDependencyPayload>(
    `${base}/repos/${issue.repo.owner}/${issue.repo.name}/issues/${issue.number}/dependencies/blocked_by?per_page=100`,
    (url) => githubGet<GitHubDependencyPayload[]>(url, getToken),
  );
  return payloads.map((p) => {
    const repo = parseRepoFromUrl(p.repository_url);
    return { project: `${repo.owner}/${repo.name}`, key: String(p.number) };
  });
}

/**
 * Prerequisite work items ("blocked by") for one GitHub issue (#85). Native
 * dependencies API first; body-text parsing ("Blocked by #N" / "Depends on #N")
 * only when native is empty or unavailable (404/410) — native links are removable
 * in GitHub's UI while stale body text isn't, so a union would over-block. Other
 * ApiError statuses propagate; the poll loop handles them per-target.
 */
export async function fetchGitHubDependencies(
  issue: Issue,
  getToken: GitHubTokenProvider,
  baseUrl?: string,
): Promise<SourceRef[]> {
  if (!issue.repo) return [];
  let refs: SourceRef[] = [];
  if (issue.number != null) {
    try {
      refs = await fetchNativeDependencies(issue, getToken, baseUrl);
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 410)) throw err;
    }
  }
  if (refs.length === 0) {
    refs = parseBodyDependencies(issue.body, issue.sourceRef.project, "hash");
  }
  return dedupeRefs(refs, issue.sourceRef);
}
