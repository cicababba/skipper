import type { Issue } from "@skipper/shared";

interface OpenProjectLink {
  href?: string | null;
  title?: string | null;
}

export interface OpenProjectWorkPackagePayload {
  id: number;
  subject?: string;
  description?: { format?: string; raw?: string; html?: string } | null;
  createdAt?: string;
  updatedAt?: string;
  _links?: {
    project?: OpenProjectLink | null;
    status?: OpenProjectLink | null;
    assignee?: OpenProjectLink | null;
    author?: OpenProjectLink | null;
  };
}

/** OpenProject serves RFC 3339 timestamps; normalize to UTC ISO so the
 *  orchestrator's string-comparison sort on updatedAt is well-ordered. */
export function toUtcIso(value: string | undefined): string {
  return value ? new Date(Date.parse(value)).toISOString() : new Date(0).toISOString();
}

/** Numeric project id from a HAL project href (`/api/v3/projects/<id>`); "" when
 *  absent or unparseable. Numeric ids are immutable, unlike renameable identifiers. */
export function projectIdFromHref(href: string | null | undefined): string {
  if (!href) return "";
  const match = /\/projects\/([^/]+)/.exec(href);
  return match ? match[1] : "";
}

export function mapOpenProjectWorkPackage(
  payload: OpenProjectWorkPackagePayload,
  accountId: string,
  baseUrl: string,
  isClosedByStatusHref: Map<string, boolean>,
): Issue {
  const links = payload._links ?? {};
  const assignee = links.assignee?.title ?? undefined;
  const author = links.author?.title ?? undefined;
  const statusHref = links.status?.href ?? undefined;
  const closed = statusHref ? isClosedByStatusHref.get(statusHref) === true : false;
  const base = baseUrl.replace(/\/+$/, "");
  return {
    id: `openproject:${payload.id}`,
    source: "openproject",
    sourceRef: { project: projectIdFromHref(links.project?.href), key: String(payload.id) },
    // Placeholder for repo-less OpenProject work packages: the effective code host
    // comes from the project→repo mapping in resolveProjectRepos (#81), which
    // overwrites this when it fills the repo. Bare here because a work package
    // carries no host itself.
    codeHost: "github",
    accountId,
    key: String(payload.id),
    number: payload.id,
    title: payload.subject ?? "",
    body: payload.description?.raw || undefined,
    labels: [],
    assignees: assignee ? [assignee] : [],
    author,
    url: `${base}/work_packages/${payload.id}`,
    createdAt: toUtcIso(payload.createdAt),
    updatedAt: toUtcIso(payload.updatedAt),
    kind: "issue",
    state: closed ? "closed" : "open",
  };
}
