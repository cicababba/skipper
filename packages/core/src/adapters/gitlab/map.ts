import type { Issue, PullRequest, RepoRef } from "@skipper/shared";

interface GitLabWorkItemPayload {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  web_url: string;
  created_at: string;
  updated_at: string;
  labels?: string[] | null;
  assignees?: Array<{ username: string }> | null;
  author?: { username: string } | null;
  references?: { full?: string };
}

export interface GitLabIssuePayload extends GitLabWorkItemPayload {
  state: "opened" | "closed";
}

export interface GitLabMrPayload extends GitLabWorkItemPayload {
  state: "opened" | "closed" | "locked" | "merged";
  draft?: boolean;
  source_branch: string;
  target_branch: string;
  sha?: string | null;
  merge_status?: string;
}

export interface GitLabMrDetailPayload extends GitLabMrPayload {
  head_pipeline?: { status?: string } | null;
}

export interface GitLabApprovalsPayload {
  approved?: boolean;
  approvals_left?: number;
}

export function repoRefFromPath(path: string): RepoRef {
  const segments = path.split("/").filter(Boolean);
  const name = segments.pop() ?? "";
  return { owner: segments.join("/"), name };
}

function projectPathFromReference(
  full: string | undefined,
  sep: "#" | "!",
  iid: number,
): string | undefined {
  if (!full) return undefined;
  const suffix = `${sep}${iid}`;
  return full.endsWith(suffix) ? full.slice(0, -suffix.length) : undefined;
}

function projectPathFromWebUrl(webUrl: string): string {
  // Project pages split the path on "/-/"; everything before it (minus the origin) is the project path.
  const beforeSeparator = webUrl.split("/-/")[0];
  try {
    return new URL(beforeSeparator).pathname.replace(/^\/+/, "");
  } catch {
    return "";
  }
}

/** references.full carries the nested-group path ("group/sub/project#42" / "...!42"); web_url is the fallback. */
export function repoFromPayload(payload: GitLabWorkItemPayload, sep: "#" | "!"): RepoRef {
  const path =
    projectPathFromReference(payload.references?.full, sep, payload.iid) ??
    projectPathFromWebUrl(payload.web_url);
  return repoRefFromPath(path);
}

function mapBase(payload: GitLabWorkItemPayload, accountId: string, sep: "#" | "!") {
  const repo = repoFromPayload(payload, sep);
  const key = String(payload.iid);
  return {
    id: `gitlab:${payload.id}`,
    source: "gitlab" as const,
    sourceRef: { project: `${repo.owner}/${repo.name}`, key },
    codeHost: "gitlab" as const,
    accountId,
    repo,
    key,
    number: payload.iid,
    title: payload.title,
    body: payload.description ?? undefined,
    labels: payload.labels ?? [],
    assignees: (payload.assignees ?? []).map((a) => a.username),
    author: payload.author?.username,
    url: payload.web_url,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
  };
}

export function mapIssue(payload: GitLabIssuePayload, accountId: string): Issue {
  return {
    ...mapBase(payload, accountId, "#"),
    kind: "issue",
    state: payload.state === "closed" ? "closed" : "open",
  };
}

function mergeableFromStatus(status: string | undefined): boolean | undefined {
  if (status === "can_be_merged") return true;
  if (status === "cannot_be_merged" || status === "cannot_be_merged_recheck") return false;
  return undefined; // unchecked / checking
}

export function mapMergeRequest(payload: GitLabMrPayload, accountId: string): PullRequest {
  const merged = payload.state === "merged";
  return {
    ...mapBase(payload, accountId, "!"),
    kind: "pull-request",
    // "locked" is a transient mid-merge state — treat it as still open.
    state: merged || payload.state === "closed" ? "closed" : "open",
    merged,
    draft: payload.draft ?? false,
    headRef: payload.source_branch,
    baseRef: payload.target_branch,
    headSha: payload.sha ?? undefined,
    mergeable: mergeableFromStatus(payload.merge_status),
  };
}

export function ciStatusFromPipeline(status: string | undefined): PullRequest["ciStatus"] {
  switch (status) {
    case "success":
      return "passing";
    case "failed":
    case "canceled":
      return "failing";
    case "running":
    case "pending":
    case "created":
    case "preparing":
    case "waiting_for_resource":
    case "scheduled":
      return "pending";
    default:
      // skipped and manual pipelines carry no pass/fail signal — deliberately
      // undefined (like an absent pipeline) so the shepherd neither blocks nor
      // greenlights on them.
      return undefined;
  }
}

/** GitLab has no changes-requested review vote, so an unresolved discussion thread
 *  stands in for it and takes precedence over an approval — mirrors GitHub, where a
 *  changes-requested review beats an approval. approvals_left is the rule-aware
 *  signal; `approved` is the older/free-tier fallback when it is absent. */
export function deriveGitLabReviewDecision(
  approvals: GitLabApprovalsPayload | undefined,
  hasUnresolvedThreads: boolean,
): NonNullable<PullRequest["reviewDecision"]> {
  if (hasUnresolvedThreads) return "changes-requested";
  const approved =
    approvals?.approvals_left != null
      ? approvals.approvals_left === 0
      : approvals?.approved === true;
  return approved ? "approved" : "review-required";
}

/** Merge detail (head_pipeline) + approvals + unresolved-thread signal into an open MR. */
export function applyMrDetails(
  mr: PullRequest,
  detail: GitLabMrDetailPayload,
  approvals: GitLabApprovalsPayload | undefined,
  hasUnresolvedThreads: boolean,
): PullRequest {
  return {
    ...mr,
    ciStatus: ciStatusFromPipeline(detail.head_pipeline?.status ?? undefined),
    reviewDecision: deriveGitLabReviewDecision(approvals, hasUnresolvedThreads),
  };
}
