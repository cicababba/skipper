// ============================================================
// Skipper — Platform-neutral inbox items (Issue / PullRequest)
// ============================================================

/** Read-side platforms. Bitbucket/Jira arrive in v3. */
export type PlatformId = "github";

export interface RepoRef {
  owner: string;
  name: string;
}

/** Canonical "owner/name" key — the per-repo partition/scoping axis. */
export function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

interface WorkItemBase {
  /** Platform-scoped stable id, e.g. "github:1234567890". */
  id: string;
  platform: PlatformId;
  /** Which connected Account (Account.id) sees this item. */
  accountId: string;
  repo: RepoRef;
  number: number;
  title: string;
  body?: string;
  labels: string[];
  /** Platform usernames (GitHub logins). */
  assignees: string[];
  author?: string;
  url: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface Issue extends WorkItemBase {
  kind: "issue";
  state: "open" | "closed";
}

export interface PullRequest extends WorkItemBase {
  kind: "pull-request";
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** Filled by detail hydration; undefined for closed/merged PRs in v1. */
  headRef?: string;
  baseRef?: string;
  /** Head commit sha from detail hydration — anchors CI evidence to a push. */
  headSha?: string;
  mergeable?: boolean;
  /** Not populated in v1 — reserved for the orchestrator (#6). */
  reviewDecision?: "approved" | "changes-requested" | "review-required";
  ciStatus?: "passing" | "failing" | "pending";
}
