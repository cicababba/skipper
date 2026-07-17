// ============================================================
// Skipper — Platform-neutral inbox items (Issue / PullRequest)
// ============================================================

/** Where the work item is tracked (issue-tracker axis, epic #68). Widens: Jira. */
export type IssueSourceId = "github" | "gitlab";

/** Where the code lives (git-host axis, epic #68). */
export type CodeHostId = "github" | "gitlab";

export interface RepoRef {
  owner: string;
  name: string;
}

/**
 * Canonical lowercased "owner/name" key — the per-repo partition/scoping axis.
 * Always anchored to the code-host repo, never to a tracker project.
 */
export function repoKey(repo: RepoRef): string {
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
}

/** Tracker-side coordinates of a work item. */
export interface SourceRef {
  /** Tracker project scope: "owner/name" for GitHub, project key ("PROJ") for Jira. */
  project: string;
  /** Native display key: "42" (GitHub) or "PROJ-123" (Jira). Mirrored as WorkItem.key. */
  key: string;
}

/**
 * Canonical "project#key" identity for a SourceRef — the dependency-matching axis
 * (#85). Project lowercased because GitHub owner/name is case-insensitive (repoKey
 * already does the same); key kept verbatim.
 */
export function sourceRefKey(ref: SourceRef): string {
  return `${ref.project.toLowerCase()}#${ref.key}`;
}

interface WorkItemBase {
  /** Source-scoped stable id, e.g. "github:1234567890". */
  id: string;
  source: IssueSourceId;
  sourceRef: SourceRef;
  codeHost: CodeHostId;
  /** Which connected Account sees this item — the account key (Account.key). */
  accountId: string;
  repo: RepoRef;
  /** Display id: "42" (GitHub) or "PROJ-123" (Jira). Same as sourceRef.key. */
  key: string;
  /** Present when the source numbers items (GitHub); Jira has none. */
  number?: number;
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
  /** Code hosts number their PRs — always present, unlike issue keys. */
  number: number;
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
