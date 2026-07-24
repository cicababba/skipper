import type { Issue } from "@skipper/shared";
import { openprojectApiBase, openprojectGet } from "./client";
import { toUtcIso } from "./map";
import type { IssueComment } from "../types";
import type { OpenProjectTokenProvider } from "./types";

const PAGE_SIZE = 100;

interface ActivityElement {
  comment?: { raw?: string } | null;
  createdAt?: string;
  _links?: { user?: { title?: string } | null };
}

interface ActivityCollection {
  total?: number;
  count?: number;
  _embedded?: { elements?: ActivityElement[] };
}

/** Comments on one work package, ascending chronological (#144). Work-package
 *  activities interleave field-change journal entries with real comments; only
 *  entries carrying a non-empty `comment.raw` are user comments. */
export async function fetchOpenProjectComments(
  issue: Issue,
  getToken: OpenProjectTokenProvider,
  baseUrl?: string,
  authMethod?: "oauth" | "pat",
): Promise<IssueComment[]> {
  const base = openprojectApiBase(baseUrl);
  const out: IssueComment[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
      offset: String(page),
    });
    const coll = await openprojectGet<ActivityCollection>(
      `${base}/api/v3/work_packages/${issue.key}/activities?${params.toString()}`,
      getToken,
      authMethod,
    );
    const elements = coll._embedded?.elements ?? [];
    for (const a of elements) {
      const raw = a.comment?.raw;
      if (!raw) continue;
      out.push({
        author: a._links?.user?.title ?? "unknown",
        body: raw,
        createdAt: toUtcIso(a.createdAt),
      });
    }
    if (elements.length === 0 || page * PAGE_SIZE >= (coll.total ?? 0)) break;
    page += 1;
  }
  return out;
}
