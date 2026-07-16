import type { Issue, PullRequest, RepoRef } from "@skipper/shared";

export interface GitHubIssuePayload {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name?: string } | string>;
  assignees?: Array<{ login: string }> | null;
  user?: { login: string } | null;
  repository_url: string;
  draft?: boolean;
  pull_request?: { merged_at: string | null };
}

export interface GitHubPullPayload {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: { login: string } | null;
  labels?: Array<{ name?: string } | string> | null;
  assignees?: Array<{ login: string }> | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export function parseRepoFromUrl(repositoryUrl: string): RepoRef {
  const parts = repositoryUrl.split("/");
  return { owner: parts[parts.length - 2] ?? "", name: parts[parts.length - 1] ?? "" };
}

function mapBase(payload: GitHubIssuePayload, accountId: string) {
  const repo = parseRepoFromUrl(payload.repository_url);
  const key = String(payload.number);
  return {
    id: `github:${payload.id}`,
    source: "github" as const,
    sourceRef: { project: `${repo.owner}/${repo.name}`, key },
    codeHost: "github" as const,
    accountId,
    repo,
    key,
    number: payload.number,
    title: payload.title,
    body: payload.body ?? undefined,
    labels: payload.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    assignees: (payload.assignees ?? []).map((a) => a.login),
    author: payload.user?.login,
    url: payload.html_url,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
  };
}

export function mapIssue(payload: GitHubIssuePayload, accountId: string): Issue {
  return { ...mapBase(payload, accountId), kind: "issue", state: payload.state };
}

export function mapPullFromIssue(payload: GitHubIssuePayload, accountId: string): PullRequest {
  return {
    ...mapBase(payload, accountId),
    kind: "pull-request",
    state: payload.state,
    merged: payload.pull_request?.merged_at != null,
    draft: payload.draft ?? false,
  };
}

/** Full PR from a /pulls/{n} payload, for tracked PRs absent from the delta stream (#11).
 *  Carries the pull-record id (differs from the issue-record id of the list streams) —
 *  consumers match tracked PRs by repo + number, never by id. */
export function mapPullDetail(
  payload: GitHubPullPayload,
  accountId: string,
  repo: RepoRef,
): PullRequest {
  return {
    id: `github:${payload.id}`,
    source: "github",
    sourceRef: { project: `${repo.owner}/${repo.name}`, key: String(payload.number) },
    codeHost: "github",
    accountId,
    repo,
    key: String(payload.number),
    number: payload.number,
    title: payload.title,
    body: payload.body ?? undefined,
    labels: (payload.labels ?? [])
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter(Boolean),
    assignees: (payload.assignees ?? []).map((a) => a.login),
    author: payload.user?.login,
    url: payload.html_url,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
    kind: "pull-request",
    state: payload.state,
    merged: payload.merged,
    draft: payload.draft,
    mergeable: payload.mergeable ?? undefined,
    headRef: payload.head.ref,
    baseRef: payload.base.ref,
    headSha: payload.head.sha,
  };
}

/** Merge /pulls/{n} details into a list-level PR. */
export function applyPullDetails(pr: PullRequest, details: GitHubPullPayload): PullRequest {
  return {
    ...pr,
    state: details.state,
    merged: details.merged,
    draft: details.draft,
    mergeable: details.mergeable ?? undefined,
    headRef: details.head.ref,
    baseRef: details.base.ref,
    headSha: details.head.sha,
  };
}
