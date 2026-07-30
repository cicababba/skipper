import type { Issue } from "@skipper/shared";
import { ApiError, type CreateIssueParams } from "../types";
import { markdownToAdf } from "./adf";
import { jiraApiBase, jiraGet, jiraPost, type JiraTarget } from "./client";
import { mapJiraIssue, type JiraIssuePayload } from "./map";
import { JIRA_ISSUE_FIELDS } from "./poll";
import type { JiraTokenProvider } from "./types";

interface JiraIssueType {
  id: string;
  name?: string;
  subtask?: boolean;
}

interface ScopedCreateMeta {
  /** Data Center shape; Cloud paginates the same list under `values`. */
  issueTypes?: JiraIssueType[];
  values?: JiraIssueType[];
}

interface ClassicCreateMeta {
  projects?: Array<{ issuetypes?: JiraIssueType[] }>;
}

interface CreatedIssuePayload {
  id: string;
  key: string;
}

/** Jira labels cannot contain spaces — the tracker rejects the whole create. */
function sanitizeLabels(labels: string[]): string[] {
  return labels.map((l) => l.trim().replace(/\s+/g, "-")).filter((l) => l.length > 0);
}

/** The issue type is mandatory and its ids are per-project, so it has to be looked
 *  up. "Task" is the neutral default; anything else the project offers beats
 *  failing, and sub-task types are never standalone-creatable. */
async function resolveIssueTypeId(
  base: string,
  version: string,
  projectKey: string,
  getToken: JiraTokenProvider,
): Promise<string> {
  let types: JiraIssueType[];
  try {
    const scoped = await jiraGet<ScopedCreateMeta>(
      `${base}/rest/api/${version}/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      getToken,
    );
    types = scoped.issueTypes ?? scoped.values ?? [];
  } catch (err) {
    // Data Center before 8.4 has no scoped endpoint — only the classic one.
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    const params = new URLSearchParams({
      projectKeys: projectKey,
      expand: "projects.issuetypes",
    });
    const classic = await jiraGet<ClassicCreateMeta>(
      `${base}/rest/api/${version}/issue/createmeta?${params.toString()}`,
      getToken,
    );
    types = classic.projects?.[0]?.issuetypes ?? [];
  }
  const creatable = types.filter((t) => t.subtask !== true);
  const chosen = creatable.find((t) => t.name?.toLowerCase() === "task") ?? creatable[0];
  if (!chosen) {
    throw new Error(`Jira project ${projectKey} offers no creatable issue types`);
  }
  return chosen.id;
}

/** Creates a Jira issue (#274) and returns it fully mapped. The create response
 *  carries only id/key, so the issue is re-read with the poll's field set before
 *  mapping. Assignees are dropped — assigning needs an accountId lookup that is
 *  out of scope. ApiError propagates (403 when the token predates the
 *  write:jira-work scope — the account has to be reconnected). */
export async function createJiraIssue(
  params: CreateIssueParams,
  getToken: JiraTokenProvider,
  baseUrl?: string,
  cloudId?: string,
): Promise<Issue> {
  const projectKey = params.project;
  if (!projectKey) {
    throw new Error(
      "a Jira issue needs a project — map this repo to a Jira project in Settings",
    );
  }
  const target: JiraTarget = { cloudId, baseUrl };
  const base = jiraApiBase(target);
  const version = cloudId ? "3" : "2";
  const issueTypeId = await resolveIssueTypeId(base, version, projectKey, getToken);
  const labels = sanitizeLabels(params.labels ?? []);

  const created = await jiraPost<CreatedIssuePayload>(
    `${base}/rest/api/${version}/issue`,
    getToken,
    {
      fields: {
        project: { key: projectKey },
        summary: params.title,
        issuetype: { id: issueTypeId },
        ...(labels.length > 0 && { labels }),
        ...(params.body !== undefined && {
          description: version === "3" ? markdownToAdf(params.body) : params.body,
        }),
      },
    },
  );

  const payload = await jiraGet<JiraIssuePayload>(
    `${base}/rest/api/${version}/issue/${created.key}?fields=${JIRA_ISSUE_FIELDS}`,
    getToken,
  );
  return mapJiraIssue(payload, params.accountId, baseUrl ?? base);
}
