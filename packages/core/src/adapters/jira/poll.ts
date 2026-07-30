import type { Issue } from "@skipper/shared";
import { jiraApiBase, jiraGet, type JiraTarget } from "./client";
import { mapJiraIssue, type JiraIssuePayload } from "./map";
import { ApiError } from "../types";
import {
  asJiraCursor,
  emptyJiraCursor,
  type JiraAccountCursor,
  type JiraPollOptions,
  type JiraPollResult,
  type JiraTokenProvider,
} from "./types";

// Jira `updated` is minute-granular (60s floor) + up to ~60s client↔server clock
// skew; overlap by 120s so a delta never drops an edit landing in the same minute.
const SINCE_OVERLAP_MS = 120_000;
// Beyond a week the relative window is meaningless — treat the cursor as stale and
// force a full walk instead of asking Jira for a huge slice.
const MAX_DELTA_WINDOW_MINUTES = 7 * 24 * 60;
const CLOUD_PAGE_SIZE = 100;
const DC_PAGE_SIZE = 50;
export const JIRA_ISSUE_FIELDS =
  "summary,description,labels,components,assignee,reporter,status,project,created,updated";

interface CloudSearchPage {
  issues?: JiraIssuePayload[];
  nextPageToken?: string;
  isLast?: boolean;
}

interface DcSearchPage {
  issues?: JiraIssuePayload[];
  startAt?: number;
  maxResults?: number;
  total?: number;
}

/** Minutes to look back for a delta poll, or undefined when the cursor is missing,
 *  malformed, or too stale — the caller then does a full walk. */
function deltaMinutes(updatedAfter: string | undefined): number | undefined {
  if (!updatedAfter) return undefined;
  const since = Date.parse(updatedAfter);
  if (!Number.isFinite(since)) return undefined;
  const minutesAgo = Math.ceil((Date.now() - since + SINCE_OVERLAP_MS) / 60_000);
  if (minutesAgo > MAX_DELTA_WINDOW_MINUTES) return undefined;
  return Math.max(minutesAgo, 1);
}

async function searchIssues(
  target: JiraTarget,
  jql: string,
  getToken: JiraTokenProvider,
): Promise<JiraIssuePayload[]> {
  const base = jiraApiBase(target);
  const out: JiraIssuePayload[] = [];

  if (target.cloudId) {
    // Cloud: classic /rest/api/3/search was removed in 2025 — use /search/jql with
    // opaque nextPageToken pagination (no `total`).
    let nextPageToken: string | undefined;
    for (;;) {
      const params = new URLSearchParams({
        jql,
        maxResults: String(CLOUD_PAGE_SIZE),
        fields: JIRA_ISSUE_FIELDS,
      });
      if (nextPageToken) params.set("nextPageToken", nextPageToken);
      const page = await jiraGet<CloudSearchPage>(
        `${base}/rest/api/3/search/jql?${params.toString()}`,
        getToken,
      );
      const issues = page.issues ?? [];
      out.push(...issues);
      if (!page.nextPageToken || issues.length === 0) break;
      nextPageToken = page.nextPageToken;
    }
  } else {
    // Data Center: classic /rest/api/2/search with startAt/total pagination.
    let startAt = 0;
    for (;;) {
      const params = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(DC_PAGE_SIZE),
        fields: JIRA_ISSUE_FIELDS,
      });
      const page = await jiraGet<DcSearchPage>(
        `${base}/rest/api/2/search?${params.toString()}`,
        getToken,
      );
      const issues = page.issues ?? [];
      out.push(...issues);
      startAt += issues.length;
      if (issues.length === 0 || startAt >= (page.total ?? 0)) break;
    }
  }

  return out;
}

export async function pollJiraAccount(options: JiraPollOptions): Promise<JiraPollResult> {
  const cursor = asJiraCursor(options.cursor);
  try {
    return await runPoll(options, cursor);
  } catch (err) {
    // Both Cloud and DC return 400 for bad JQL — recover a rejected cursor with a full walk.
    if (cursor && err instanceof ApiError && err.status === 400) {
      options.onProgress?.("cursor rejected (400) — falling back to full walk");
      return runPoll(options, undefined);
    }
    throw err;
  }
}

async function runPoll(
  options: JiraPollOptions,
  cursor: JiraAccountCursor | undefined,
): Promise<JiraPollResult> {
  const { accountId, getToken, onProgress, baseUrl, cloudId } = options;
  const target: JiraTarget = { cloudId, baseUrl };
  const browseBase = baseUrl ?? jiraApiBase(target);

  const minutesAgo = cursor ? deltaMinutes(cursor.issues.updatedAfter) : undefined;
  const mode = minutesAgo != null ? "delta" : "full";
  // Delta drops `resolution = EMPTY` so just-resolved issues arrive and reconcile
  // closes the tracked item. De-assignments are missed until the orchestrator's
  // forced full walk — a shared limitation with the GitHub/GitLab adapters.
  const jql =
    minutesAgo != null
      ? `assignee = currentUser() AND updated >= -${minutesAgo}m ORDER BY updated DESC`
      : "assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC";

  const payloads = await searchIssues(target, jql, getToken);
  onProgress?.(`issues: ${payloads.length} items`);

  const issues: Issue[] = payloads.map((p) => mapJiraIssue(p, accountId, browseBase));

  // Empty delta keeps the previous updatedAfter so the window doesn't shrink.
  let updatedAfter = cursor?.issues.updatedAfter;
  if (payloads.length > 0) {
    const maxUpdated = Math.max(
      ...payloads.map((p) => Date.parse(p.fields.updated ?? "")).filter(Number.isFinite),
    );
    if (Number.isFinite(maxUpdated)) updatedAfter = new Date(maxUpdated).toISOString();
  }

  return {
    mode,
    issues,
    pullRequests: [],
    cursor: {
      ...emptyJiraCursor(),
      issues: { updatedAfter },
      lastPolledAt: new Date().toISOString(),
    },
  };
}
