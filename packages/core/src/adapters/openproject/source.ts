import type { Issue } from "@skipper/shared";
import { fetchOpenProjectComments } from "./comments";
import type { IssueComment, IssueSource, TokenProvider } from "../types";
import { pollOpenProjectAccount } from "./poll";
import type { OpenProjectAccountCursor, OpenProjectPollOptions, OpenProjectPollResult } from "./types";

export const openprojectIssueSource: IssueSource<OpenProjectAccountCursor> = {
  id: "openproject",
  authProvider: "openproject",
  // Method syntax (not an arrow property) — see the note in ../types.ts.
  poll(opts: OpenProjectPollOptions): Promise<OpenProjectPollResult> {
    return pollOpenProjectAccount(opts);
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
};
