import type { IssueSource } from "../types";
import { pollGitHubAccount } from "./poll";
import type { GitHubAccountCursor } from "./types";

export const githubIssueSource: IssueSource<GitHubAccountCursor> = {
  platform: "github",
  authProvider: "github",
  poll: (opts) => pollGitHubAccount(opts),
};
