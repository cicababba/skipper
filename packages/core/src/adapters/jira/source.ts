import type { Issue, SourceRef } from "@skipper/shared";
import { fetchJiraComments } from "./comments";
import { createJiraIssue } from "./create";
import { fetchJiraDependencies } from "./dependencies";
import type { CreateIssueParams, IssueComment, IssueSource, TokenProvider } from "../types";
import { pollJiraAccount } from "./poll";
import type { JiraAccountCursor, JiraPollOptions, JiraPollResult } from "./types";

export const jiraIssueSource: IssueSource<JiraAccountCursor> = {
  id: "jira",
  authProvider: "jira",
  // Method syntax (not an arrow property) — see the note in ../types.ts.
  poll(opts: JiraPollOptions): Promise<JiraPollResult> {
    return pollJiraAccount(opts);
  },
  fetchDependencies(issue: Issue): Promise<SourceRef[]> {
    return fetchJiraDependencies(issue);
  },
  fetchComments(
    issue: Issue,
    getToken: TokenProvider,
    baseUrl?: string,
    cloudId?: string,
  ): Promise<IssueComment[]> {
    return fetchJiraComments(issue, getToken, baseUrl, cloudId);
  },
  createIssue(
    params: CreateIssueParams,
    getToken: TokenProvider,
    baseUrl?: string,
    cloudId?: string,
  ): Promise<Issue> {
    return createJiraIssue(params, getToken, baseUrl, cloudId);
  },
};
