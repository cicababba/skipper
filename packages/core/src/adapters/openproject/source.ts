import type { Issue, SourceRef } from "@skipper/shared";
import { fetchOpenProjectComments } from "./comments";
import { createOpenProjectIssue } from "./create";
import { fetchOpenProjectDependencies } from "./dependencies";
import type { CreateIssueParams, IssueComment, IssueSource, TokenProvider } from "../types";
import { pollOpenProjectAccount } from "./poll";
import type { OpenProjectAccountCursor, OpenProjectPollOptions, OpenProjectPollResult } from "./types";

export const openprojectIssueSource: IssueSource<OpenProjectAccountCursor> = {
  id: "openproject",
  authProvider: "openproject",
  // Method syntax (not an arrow property) — see the note in ../types.ts.
  poll(opts: OpenProjectPollOptions): Promise<OpenProjectPollResult> {
    return pollOpenProjectAccount(opts);
  },
  fetchDependencies(
    issue: Issue,
    getToken: TokenProvider,
    baseUrl?: string,
    _cloudId?: string,
    authMethod?: "oauth" | "pat",
  ): Promise<SourceRef[]> {
    return fetchOpenProjectDependencies(issue, getToken, baseUrl, authMethod);
  },
  fetchComments(
    issue: Issue,
    getToken: TokenProvider,
    baseUrl?: string,
    _cloudId?: string,
    authMethod?: "oauth" | "pat",
  ): Promise<IssueComment[]> {
    return fetchOpenProjectComments(issue, getToken, baseUrl, authMethod);
  },
  createIssue(
    params: CreateIssueParams,
    getToken: TokenProvider,
    baseUrl?: string,
    _cloudId?: string,
    authMethod?: "oauth" | "pat",
  ): Promise<Issue> {
    return createOpenProjectIssue(params, getToken, baseUrl, authMethod);
  },
};
