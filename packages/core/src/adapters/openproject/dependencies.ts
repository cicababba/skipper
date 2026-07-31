import type { Issue, SourceRef } from "@skipper/shared";
import { openprojectApiBase, openprojectGet } from "./client";
import { projectIdFromHref } from "./map";
import { dedupeRefs, parseBodyDependencies } from "../dependencies";
import type { OpenProjectTokenProvider } from "./types";

interface RelationElement {
  type?: string;
  _links?: {
    from?: { href?: string | null } | null;
    to?: { href?: string | null } | null;
  };
}

interface RelationCollection {
  _embedded?: { elements?: RelationElement[] };
}

interface WorkPackageProjectPayload {
  _links?: { project?: { href?: string | null } | null };
}

/** Trailing id segment of a work-package href — hrefs are served relative
 *  (`/api/v3/work_packages/42`) or absolute depending on the endpoint. */
function workPackageId(href: string | null | undefined): string {
  if (!href) return "";
  const match = /\/work_packages\/([^/?#]+)/.exec(href);
  return match ? match[1] : "";
}

/** The other end of a relation when it makes `self` the dependent side. OpenProject
 *  serves a relation from either direction, so both spellings are handled: "blocks"
 *  and "precedes" point at the dependent, "blocked" and "follows" point away. */
function blockerIdFor(relation: RelationElement, self: string): string {
  const from = workPackageId(relation._links?.from?.href);
  const to = workPackageId(relation._links?.to?.href);
  switch (relation.type) {
    case "blocks":
    case "precedes":
      return to === self ? from : "";
    case "blocked":
    case "follows":
      return from === self ? to : "";
    default:
      return "";
  }
}

/**
 * Prerequisite work items ("blocked by") for one OpenProject work package (#299).
 * Native relations first, body text ("Blocked by #42") only when there are none —
 * the GitHub adapter's native-wins rationale. The relation payload carries work
 * package ids but not their project, so each blocker is resolved with one extra
 * GET; dependency counts are small.
 */
export async function fetchOpenProjectDependencies(
  issue: Issue,
  getToken: OpenProjectTokenProvider,
  baseUrl?: string,
  authMethod?: "oauth" | "pat",
): Promise<SourceRef[]> {
  const base = openprojectApiBase(baseUrl);
  const collection = await openprojectGet<RelationCollection>(
    `${base}/api/v3/work_packages/${issue.key}/relations`,
    getToken,
    authMethod,
  );

  const blockerIds: string[] = [];
  for (const relation of collection._embedded?.elements ?? []) {
    const id = blockerIdFor(relation, issue.key);
    // Self-relations are dropped here rather than by dedupeRefs, which can only
    // compare a ref once its project is known — one request that buys nothing.
    if (id && id !== issue.key && !blockerIds.includes(id)) blockerIds.push(id);
  }

  const refs: SourceRef[] = [];
  for (const id of blockerIds) {
    const wp = await openprojectGet<WorkPackageProjectPayload>(
      `${base}/api/v3/work_packages/${id}`,
      getToken,
      authMethod,
    );
    const project = projectIdFromHref(wp._links?.project?.href);
    if (project) refs.push({ project, key: id });
  }

  return dedupeRefs(
    refs.length > 0 ? refs : parseBodyDependencies(issue.body, issue.sourceRef.project, "hash"),
    issue.sourceRef,
  );
}
