import type { Issue } from "@skipper/shared";
import { adfToMarkdown } from "./adf";
import { jiraApiBase, jiraGet, type JiraTarget } from "./client";
import { toUtcIso } from "./map";
import type { IssueComment } from "../types";
import type { JiraTokenProvider } from "./types";

const PAGE_SIZE = 100;

interface JiraCommentAuthor {
  displayName?: string;
  name?: string;
  key?: string;
  accountId?: string;
}

interface JiraCommentPayload {
  author?: JiraCommentAuthor | null;
  /** Cloud: ADF document (object). Data Center: plain string. */
  body?: unknown;
  created?: string;
}

interface JiraCommentPage {
  comments?: JiraCommentPayload[];
  startAt?: number;
  maxResults?: number;
  total?: number;
}

function authorName(author: JiraCommentAuthor | null | undefined): string {
  if (!author) return "unknown";
  return author.displayName ?? author.name ?? author.key ?? author.accountId ?? "unknown";
}

function commentBody(body: unknown): string {
  if (typeof body === "string") return body;
  return adfToMarkdown(body) ?? "";
}

/** Comments on one Jira issue, ascending chronological (#144). Cloud routes via
 *  api.atlassian.com/ex/jira/<cloudId>/rest/api/3 (ADF bodies); Data Center hits
 *  the instance /rest/api/2 (string bodies). jiraApiBase throws when neither a
 *  cloudId nor a baseUrl is available — the caller catches and degrades. */
export async function fetchJiraComments(
  issue: Issue,
  getToken: JiraTokenProvider,
  baseUrl?: string,
  cloudId?: string,
): Promise<IssueComment[]> {
  const target: JiraTarget = { cloudId, baseUrl };
  const base = jiraApiBase(target);
  const apiVersion = target.cloudId ? "3" : "2";
  const out: IssueComment[] = [];
  let startAt = 0;
  for (;;) {
    const params = new URLSearchParams({
      startAt: String(startAt),
      maxResults: String(PAGE_SIZE),
      orderBy: "created",
    });
    const page = await jiraGet<JiraCommentPage>(
      `${base}/rest/api/${apiVersion}/issue/${issue.key}/comment?${params.toString()}`,
      getToken,
    );
    const comments = page.comments ?? [];
    for (const c of comments) {
      out.push({
        author: authorName(c.author),
        body: commentBody(c.body),
        createdAt: toUtcIso(c.created),
      });
    }
    startAt += comments.length;
    if (comments.length === 0 || startAt >= (page.total ?? 0)) break;
  }
  return out;
}
