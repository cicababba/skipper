import type { IssueSource } from "../types";
import { pollJiraAccount } from "./poll";
import type { JiraAccountCursor, JiraPollOptions, JiraPollResult } from "./types";

export const jiraIssueSource: IssueSource<JiraAccountCursor> = {
  id: "jira",
  authProvider: "jira",
  // Method syntax (not an arrow property) — see the note in ../types.ts.
  poll(opts: JiraPollOptions): Promise<JiraPollResult> {
    return pollJiraAccount(opts);
  },
};
