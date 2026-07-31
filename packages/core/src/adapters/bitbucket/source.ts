import type { Issue, SourceRef } from "@skipper/shared";
import type { CreateIssueParams, IssueComment, IssueSource, TokenProvider } from "../types";
import { fetchBitbucketIssueComments } from "./comments";
import { createBitbucketIssue } from "./create";
import { fetchBitbucketDependencies } from "./dependencies";
import { pollBitbucketAccount } from "./poll";
import type { BitbucketAccountCursor, BitbucketPollOptions, BitbucketPollResult } from "./types";

export const bitbucketIssueSource: IssueSource<BitbucketAccountCursor> = {
  id: "bitbucket",
  authProvider: "bitbucket",
  // Method syntax (not an arrow property) — see the note in ../types.ts.
  poll(opts: BitbucketPollOptions): Promise<BitbucketPollResult> {
    return pollBitbucketAccount(opts);
  },
  fetchDependencies(issue: Issue): Promise<SourceRef[]> {
    return fetchBitbucketDependencies(issue);
  },
  fetchComments(issue: Issue, getToken: TokenProvider): Promise<IssueComment[]> {
    return fetchBitbucketIssueComments(issue, getToken);
  },
  createIssue(params: CreateIssueParams, getToken: TokenProvider): Promise<Issue> {
    return createBitbucketIssue(params, getToken);
  },
};
