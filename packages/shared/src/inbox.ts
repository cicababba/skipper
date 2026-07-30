// ============================================================
// Skipper — Platform-neutral inbox items (Issue / PullRequest)
// ============================================================

/** Where the work item is tracked (issue-tracker axis, epic #68). */
export type IssueSourceId = "github" | "gitlab" | "jira" | "openproject" | "bitbucket";

/** Where the code lives (git-host axis, epic #68). */
export type CodeHostId = "github" | "gitlab" | "bitbucket";

const CODE_HOST_IDS: readonly CodeHostId[] = ["github", "gitlab", "bitbucket"];

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

/** Parts of a project→repo mapping key (#79). */
export interface ProjectMappingKeyParts {
  source: string;
  host: string;
  projectKey: string;
}

/**
 * Canonical key for the project→repo mapping (#79): `"<source>:<host>:<KEY>"`,
 * e.g. `jira:acme.atlassian.net:PROJ`. Host lowercased, project key uppercased so
 * lookups are deterministic whatever case the tracker reports.
 */
export function projectMappingKey(source: string, host: string, projectKey: string): string {
  return `${source}:${host.toLowerCase()}:${projectKey.toUpperCase()}`;
}

/** Host segment of a mapping key from an Account.baseUrl — "default" when absent/invalid. */
export function mappingHost(baseUrl?: string): string {
  if (!baseUrl) return "default";
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return "default";
  }
}

/** Splits a mapping key back into its parts; null when it isn't a valid key (IPC guard). */
export function parseProjectMappingKey(key: string): ProjectMappingKeyParts | null {
  const parts = key.split(":");
  if (parts.length < 3) return null;
  const [source, host, ...rest] = parts;
  const projectKey = rest.join(":");
  if (!source || !host || !projectKey) return null;
  return { source, host, projectKey };
}

/**
 * Parses a project→repo mapping value (#81): bare `owner/name` means github (the
 * historical format, kept for back-compat), `<host>:owner/name` names another code
 * host. Returns undefined when the host prefix is unknown or either half is missing.
 */
export function parseRepoMappingValue(
  value: string,
): { codeHost: CodeHostId; repo: RepoRef } | undefined {
  let codeHost: CodeHostId = "github";
  let rest = value;
  const colon = value.indexOf(":");
  if (colon !== -1) {
    const prefix = value.slice(0, colon);
    if (!(CODE_HOST_IDS as readonly string[]).includes(prefix)) return undefined;
    codeHost = prefix as CodeHostId;
    rest = value.slice(colon + 1);
  }
  // Split at the last slash: GitLab nested-group owners contain slashes
  // (group/sub/proj → owner "group/sub", name "proj").
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { codeHost, repo: { owner: rest.slice(0, slash), name: rest.slice(slash + 1) } };
}

/** Inverse of parseRepoMappingValue — github stays bare so existing stored values
 *  and lookups are unchanged. */
export function formatRepoMappingValue(codeHost: CodeHostId, repo: RepoRef): string {
  const path = `${repo.owner}/${repo.name}`;
  return codeHost === "github" ? path : `${codeHost}:${path}`;
}

export type ProjectForRepoResult =
  | { ok: true; projectKey: string }
  | { ok: false; reason: "unmapped" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

/**
 * Reverse of the project→repo mapping (#274): which tracker project of `source`
 * on `host` holds this repo's issues. Needed at create time by the project-scoped
 * trackers (Jira, OpenProject), which cannot create an issue without a project.
 * The mapping value's code-host prefix is ignored — the repo identity is the key.
 */
export function projectForRepo(
  mappings: Record<string, string>,
  target: { source: string; host: string; repo: RepoRef },
): ProjectForRepoResult {
  const wantedHost = target.host.toLowerCase();
  const wantedRepo = repoKey(target.repo);
  const found = new Set<string>();
  for (const [key, value] of Object.entries(mappings)) {
    const parts = parseProjectMappingKey(key);
    if (!parts || parts.source !== target.source || parts.host.toLowerCase() !== wantedHost) {
      continue;
    }
    const parsed = parseRepoMappingValue(value);
    if (!parsed || repoKey(parsed.repo) !== wantedRepo) continue;
    found.add(parts.projectKey);
  }
  if (found.size === 0) return { ok: false, reason: "unmapped" };
  if (found.size > 1) return { ok: false, reason: "ambiguous", candidates: [...found].sort() };
  return { ok: true, projectKey: [...found][0] };
}

interface WorkItemBase {
  /** Source-scoped stable id, e.g. "github:1234567890". */
  id: string;
  source: IssueSourceId;
  sourceRef: SourceRef;
  codeHost: CodeHostId;
  /** Which connected Account sees this item — the account key (Account.key). */
  accountId: string;
  /** Where the code lives. Absent for a tracker issue whose project has no repo
   *  mapping yet (#79) — resolution fills it before admission; PullRequest and
   *  TrackedItem always carry one. */
  repo?: RepoRef;
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
  /** A PR always lives in a repo — narrows the optional base field. */
  repo: RepoRef;
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
