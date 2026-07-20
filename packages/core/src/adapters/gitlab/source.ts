import type { IssueSource } from "../types";
import { fetchGitLabComments } from "./comments";
import { pollGitLabAccount } from "./poll";
import type { GitLabAccountCursor } from "./types";

export const gitlabIssueSource: IssueSource<GitLabAccountCursor> = {
  id: "gitlab",
  authProvider: "gitlab",
  poll: (opts) => pollGitLabAccount(opts),
  fetchComments: (issue, getToken, baseUrl) => fetchGitLabComments(issue, getToken, baseUrl),
};
