import type { Issue } from "@skipper/shared";
import { ApiError, type CreateIssueParams } from "../types";
import { bitbucketPost } from "./client";
import { mapBitbucketIssue, type BitbucketIssuePayload } from "./map";
import { repoApiUrl } from "./prs";
import type { BitbucketTokenProvider } from "./types";

/** Creates a Bitbucket issue (#274) and returns it fully mapped. Labels and
 *  assignees are dropped: Bitbucket issues have no labels, and assigning needs a
 *  uuid lookup that is out of scope. A repo with its issue tracker switched off
 *  answers 404 — surfaced as an actionable message instead of a bare "not found".
 *  Other ApiErrors propagate (403 when the token predates the issue:write scope). */
export async function createBitbucketIssue(
  params: CreateIssueParams,
  getToken: BitbucketTokenProvider,
): Promise<Issue> {
  const { repo } = params;
  let payload: BitbucketIssuePayload;
  try {
    payload = await bitbucketPost<BitbucketIssuePayload>(`${repoApiUrl(repo)}/issues`, getToken, {
      title: params.title,
      kind: "task",
      ...(params.body !== undefined && {
        content: { raw: params.body, markup: "markdown" },
      }),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new Error(
        `the Bitbucket issue tracker is disabled for ${repo.owner}/${repo.name} — enable it in the repository settings`,
      );
    }
    throw err;
  }
  return mapBitbucketIssue(
    {
      ...payload,
      repository: payload.repository ?? { full_name: `${repo.owner}/${repo.name}` },
    },
    params.accountId,
  );
}
