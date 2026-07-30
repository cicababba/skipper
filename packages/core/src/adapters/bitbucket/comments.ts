import type { Issue, RepoRef } from "@skipper/shared";
import type { IssueComment } from "../types";
import { bitbucketPaginate } from "./client";
import { toUtcIso, userName, type BitbucketCommentPayload } from "./map";
import { repoApiUrl } from "./prs";
import type { BitbucketTokenProvider } from "./types";

function repoFor(issue: Issue): RepoRef {
  if (issue.repo) return issue.repo;
  const fullName = issue.sourceRef.project;
  const slash = fullName.indexOf("/");
  return slash <= 0
    ? { owner: fullName, name: "" }
    : { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/** Comments on one Bitbucket issue, ascending chronological (#144). Deleted and
 *  empty comments are dropped — Bitbucket keeps deleted rows with a null body. */
export async function fetchBitbucketIssueComments(
  issue: Issue,
  getToken: BitbucketTokenProvider,
): Promise<IssueComment[]> {
  const params = new URLSearchParams({ sort: "created_on", pagelen: "100" });
  const payloads = await bitbucketPaginate<BitbucketCommentPayload>(
    `${repoApiUrl(repoFor(issue))}/issues/${issue.key}/comments?${params.toString()}`,
    getToken,
  );
  const out: IssueComment[] = [];
  for (const comment of payloads) {
    if (comment.deleted) continue;
    const body = comment.content?.raw?.trim();
    if (!body) continue;
    out.push({
      author: userName(comment.user) ?? "unknown",
      body,
      createdAt: toUtcIso(comment.created_on),
    });
  }
  return out;
}
