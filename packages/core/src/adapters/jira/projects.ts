import type { TrackerProject } from "@skipper/shared";
import { jiraApiBase, jiraGet, type JiraTarget } from "./client";
import type { JiraTokenProvider } from "./types";

interface JiraProjectPayload {
  id: string;
  key: string;
  name: string;
}

interface JiraProjectSearchPage {
  values: JiraProjectPayload[];
  isLast?: boolean;
}

const CLOUD_PAGE_SIZE = 50;

/**
 * Lists the projects an account can see (#79). Jira Cloud paginates
 * `GET /rest/api/3/project/search` on startAt/isLast; Data Center returns the
 * whole array from `GET /rest/api/2/project`.
 */
export async function listJiraProjects(
  getToken: JiraTokenProvider,
  target: JiraTarget,
): Promise<TrackerProject[]> {
  const base = jiraApiBase(target);
  const out: TrackerProject[] = [];

  if (target.cloudId) {
    let startAt = 0;
    for (;;) {
      const page = await jiraGet<JiraProjectSearchPage>(
        `${base}/rest/api/3/project/search?startAt=${startAt}&maxResults=${CLOUD_PAGE_SIZE}`,
        getToken,
      );
      const values = page.values ?? [];
      for (const p of values) out.push({ id: p.id, key: p.key, name: p.name });
      if (page.isLast || values.length === 0) break;
      startAt += values.length;
    }
  } else {
    const projects = await jiraGet<JiraProjectPayload[]>(`${base}/rest/api/2/project`, getToken);
    for (const p of projects ?? []) out.push({ id: p.id, key: p.key, name: p.name });
  }

  return out;
}
