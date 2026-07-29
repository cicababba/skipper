import type { IssueSource } from "../types";
import { closeGitHubIssue } from "./close";
import { fetchGitHubComments } from "./comments";
import { createGitHubIssue } from "./create";
import { fetchGitHubDependencies } from "./dependencies";
import { pollGitHubAccount } from "./poll";
import type { GitHubAccountCursor } from "./types";

export const githubIssueSource: IssueSource<GitHubAccountCursor> = {
  id: "github",
  authProvider: "github",
  poll: (opts) => pollGitHubAccount(opts),
  fetchDependencies: (issue, getToken, baseUrl) =>
    fetchGitHubDependencies(issue, getToken, baseUrl),
  fetchComments: (issue, getToken, baseUrl) => fetchGitHubComments(issue, getToken, baseUrl),
  closeIssue: (issue, getToken, baseUrl) => closeGitHubIssue(issue, getToken, baseUrl),
  createIssue: (params, getToken, baseUrl) => createGitHubIssue(params, getToken, baseUrl),
};
