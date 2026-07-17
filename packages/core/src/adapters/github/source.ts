import type { IssueSource } from "../types";
import { fetchGitHubDependencies } from "./dependencies";
import { pollGitHubAccount } from "./poll";
import type { GitHubAccountCursor } from "./types";

export const githubIssueSource: IssueSource<GitHubAccountCursor> = {
  id: "github",
  authProvider: "github",
  poll: (opts) => pollGitHubAccount(opts),
  fetchDependencies: (issue, getToken, baseUrl) =>
    fetchGitHubDependencies(issue, getToken, baseUrl),
};
