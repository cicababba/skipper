import type { TrackerProject } from "@skipper/shared";
import { openprojectApiBase, openprojectGet } from "./client";
import type { OpenProjectTokenProvider } from "./types";

const PAGE_SIZE = 100;

interface ProjectElement {
  id: number;
  name: string;
}

interface ProjectCollection {
  total?: number;
  count?: number;
  _embedded?: { elements?: ProjectElement[] };
}

/** Projects an account can see (#79). Keyed on the numeric id (both id and key)
 *  so the mapping key matches the work-package payload's project href (D1) —
 *  numeric ids are immutable, unlike the renameable identifier slug. */
export async function listOpenProjectProjects(
  getToken: OpenProjectTokenProvider,
  baseUrl: string,
  authMethod?: "oauth" | "pat",
): Promise<TrackerProject[]> {
  const base = openprojectApiBase(baseUrl);
  const out: TrackerProject[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
      offset: String(page),
    });
    const coll = await openprojectGet<ProjectCollection>(
      `${base}/api/v3/projects?${params.toString()}`,
      getToken,
      authMethod,
    );
    const elements = coll._embedded?.elements ?? [];
    for (const p of elements) out.push({ id: String(p.id), key: String(p.id), name: p.name });
    if (elements.length === 0 || page * PAGE_SIZE >= (coll.total ?? 0)) break;
    page += 1;
  }
  return out;
}
