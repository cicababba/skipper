import { GITHUB_API_BASE_URL, sourceRefKey, type Issue, type SourceRef } from "@skipper/shared";
import { githubGet, type GitHubResponse } from "./client";
import { parseRepoFromUrl } from "./map";
import { ApiError } from "../types";
import type { GitHubTokenProvider } from "./types";

interface GitHubDependencyPayload {
  number: number;
  repository_url: string;
}

// "blocked by" / "depends on", followed by a comma- or "and"-separated ref list.
// Bare-whitespace continuation is deliberately excluded so prose after a ref
// ("blocked by #3 see #4") is not swallowed.
const DEP_PHRASE_RE =
  /\b(?:blocked +by|depends +on)\b[:\s]+((?:[\w.-]+\/[\w.-]+)?#\d+(?:(?:\s*,\s*|\s+and\s+)(?:[\w.-]+\/[\w.-]+)?#\d+)*)/gi;
const DEP_REF_RE = /([\w.-]+\/[\w.-]+)?#(\d+)/g;

/** Same-tracker prerequisite refs parsed from issue body text (fallback for #85).
 *  Refs are "#N" (→ the issue's own project) or "owner/repo#N". */
export function parseBodyDependencies(body: string | undefined, project: string): SourceRef[] {
  if (!body) return [];
  const refs: SourceRef[] = [];
  for (const phrase of body.matchAll(DEP_PHRASE_RE)) {
    for (const ref of phrase[1].matchAll(DEP_REF_RE)) {
      refs.push({ project: ref[1] ?? project, key: ref[2] });
    }
  }
  return refs;
}

async function fetchNativeDependencies(
  issue: Issue,
  getToken: GitHubTokenProvider,
  baseUrl?: string,
): Promise<SourceRef[]> {
  if (!issue.repo) return [];
  const base = baseUrl ?? GITHUB_API_BASE_URL;
  const refs: SourceRef[] = [];
  let url: string | undefined = `${base}/repos/${issue.repo.owner}/${issue.repo.name}/issues/${issue.number}/dependencies/blocked_by?per_page=100`;
  while (url) {
    const res: GitHubResponse<GitHubDependencyPayload[]> = await githubGet(url, getToken);
    for (const p of res.body ?? []) {
      const repo = parseRepoFromUrl(p.repository_url);
      refs.push({ project: `${repo.owner}/${repo.name}`, key: String(p.number) });
    }
    url = res.nextUrl;
  }
  return refs;
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
    refs = parseBodyDependencies(issue.body, issue.sourceRef.project);
  }

  const selfKey = sourceRefKey(issue.sourceRef);
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const ref of refs) {
    const key = sourceRefKey(ref);
    if (key === selfKey || seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
