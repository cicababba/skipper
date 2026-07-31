import type { Issue, SourceRef } from "@skipper/shared";
import { adfToMarkdown } from "./adf";

/** Jira user shapes differ across deployments: Cloud carries `accountId`, Data
 *  Center carries `key`/`name`. */
export interface JiraUserPayload {
  accountId?: string;
  key?: string;
  name?: string;
}

export interface JiraIssuePayload {
  id: string;
  key: string;
  fields: {
    summary?: string;
    /** Cloud: ADF document (object). Data Center: plain string. */
    description?: unknown;
    labels?: string[] | null;
    components?: Array<{ name: string }> | null;
    assignee?: JiraUserPayload | null;
    reporter?: JiraUserPayload | null;
    status?: { statusCategory?: { key?: string } } | null;
    project?: { key?: string } | null;
    created?: string;
    updated?: string;
    issuelinks?: Array<{
      type?: { inward?: string; outward?: string } | null;
      /** Present on the side that is blocked; the "blocks" direction carries
       *  `outwardIssue` instead, with the same `type.inward` label. */
      inwardIssue?: { key?: string } | null;
      outwardIssue?: { key?: string } | null;
    }> | null;
  };
}

function userId(user: JiraUserPayload | null | undefined): string | undefined {
  if (!user) return undefined;
  return user.accountId ?? user.key ?? user.name ?? undefined;
}

/** Jira returns offsets like `2026-07-17T10:30:00.000+0200`; the orchestrator sorts
 *  updatedAt by string comparison, so normalize to UTC ISO. */
export function toUtcIso(value: string | undefined): string {
  return value ? new Date(Date.parse(value)).toISOString() : new Date(0).toISOString();
}

function mapBody(description: unknown): string | undefined {
  if (typeof description === "string") return description || undefined;
  return adfToMarkdown(description);
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Inward "is blocked by" links only — the outward "blocks" direction names issues
 *  this one blocks, which is not a prerequisite of it. */
function mapBlockedBy(links: JiraIssuePayload["fields"]["issuelinks"]): SourceRef[] {
  const out: SourceRef[] = [];
  for (const link of links ?? []) {
    const key = link.inwardIssue?.key;
    if (!key || link.type?.inward?.toLowerCase() !== "is blocked by") continue;
    out.push({ project: key.split("-")[0], key });
  }
  return out;
}

export function mapJiraIssue(
  payload: JiraIssuePayload,
  accountId: string,
  browseBase: string,
): Issue {
  const fields = payload.fields;
  const assignee = userId(fields.assignee);
  const labels = [
    ...(fields.labels ?? []),
    ...(fields.components ?? []).map((c) => c.name),
  ];
  const blockedBy = mapBlockedBy(fields.issuelinks);
  return {
    id: `jira:${payload.id}`,
    source: "jira",
    sourceRef: { project: fields.project?.key ?? "", key: payload.key },
    // Placeholder for repo-less Jira issues: the effective code host is derived from
    // the project→repo mapping in resolveProjectRepos (#81), which overwrites this
    // when it fills the repo. Bare here because a Jira issue carries no host itself.
    codeHost: "github",
    accountId,
    key: payload.key,
    title: fields.summary ?? "",
    body: mapBody(fields.description),
    labels,
    assignees: assignee ? [assignee] : [],
    author: userId(fields.reporter),
    url: `${trimTrailingSlash(browseBase)}/browse/${payload.key}`,
    createdAt: toUtcIso(fields.created),
    updatedAt: toUtcIso(fields.updated),
    kind: "issue",
    state: fields.status?.statusCategory?.key === "done" ? "closed" : "open",
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
  };
}
