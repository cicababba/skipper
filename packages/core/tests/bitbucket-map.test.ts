import { describe, it, expect } from "vitest";
import {
  deriveBitbucketReviewDecision,
  ciStatusFromStatuses,
  mapBitbucketIssue,
  mapBitbucketPullRequest,
  mapCommentFeedback,
  type BitbucketParticipant,
  type BitbucketCommentPayload,
} from "../src/adapters/bitbucket/map";

const repo = { owner: "acme", name: "rocket" };

describe("bitbucket map", () => {
  it("derives review decision with changes_requested beating approval", () => {
    const participants: BitbucketParticipant[] = [
      { user: { nickname: "a" }, approved: true },
      { user: { nickname: "b" }, state: "changes_requested" },
    ];
    expect(deriveBitbucketReviewDecision(participants)).toBe("changes-requested");
  });

  it("returns approved when someone approved and no one requested changes", () => {
    expect(deriveBitbucketReviewDecision([{ user: { nickname: "a" }, approved: true }])).toBe("approved");
  });

  it("returns review-required when there are no decisive votes", () => {
    expect(deriveBitbucketReviewDecision([{ user: { nickname: "a" } }])).toBe("review-required");
    expect(deriveBitbucketReviewDecision([])).toBe("review-required");
  });

  it("excludes the PR author's own vote", () => {
    const participants: BitbucketParticipant[] = [
      { user: { uuid: "author-uuid" }, state: "changes_requested" },
    ];
    expect(deriveBitbucketReviewDecision(participants, "author-uuid")).toBe("review-required");
  });

  it("computes ciStatus worst-wins across commit statuses", () => {
    expect(ciStatusFromStatuses(["SUCCESSFUL", "FAILED"])).toBe("failing");
    expect(ciStatusFromStatuses(["SUCCESSFUL", "STOPPED"])).toBe("failing");
    expect(ciStatusFromStatuses(["SUCCESSFUL", "INPROGRESS"])).toBe("pending");
    expect(ciStatusFromStatuses(["SUCCESSFUL", "SUCCESSFUL"])).toBe("passing");
    expect(ciStatusFromStatuses([])).toBeUndefined();
    expect(ciStatusFromStatuses(["UNKNOWN"])).toBeUndefined();
  });

  it("maps live comments, dropping deleted/pending/empty and the author's own", () => {
    const comments: BitbucketCommentPayload[] = [
      { id: 1, content: { raw: "please fix" }, user: { nickname: "rev" }, inline: { path: "src/a.ts", to: 10 } },
      { id: 2, deleted: true, content: { raw: "gone" } },
      { id: 3, pending: true, content: { raw: "draft" } },
      { id: 4, content: { raw: "   " } }, // empty after trim
      { id: 5, content: { raw: "author note" }, user: { uuid: "me" } },
    ];
    const mapped = mapCommentFeedback(comments, repo, 7, "me");
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ author: "rev", path: "src/a.ts", line: 10, body: "please fix" });
  });

  it("falls back the inline line from `to` to `from`", () => {
    const mapped = mapCommentFeedback(
      [{ id: 1, content: { raw: "note" }, inline: { path: "x", to: null, from: 5 } }],
      repo,
      7,
    );
    expect(mapped[0].line).toBe(5);
  });

  it("synthesizes a PR url when the comment carries no html link", () => {
    const mapped = mapCommentFeedback([{ id: 1, content: { raw: "note" } }], repo, 7);
    expect(mapped[0].url).toContain("/acme/rocket/pull-requests/7");
  });
});

function issuePayload(over: Record<string, unknown> = {}) {
  return {
    id: 3,
    title: "Fix the thing",
    content: { raw: "body text" },
    state: "new",
    reporter: { nickname: "bob" },
    assignee: { nickname: "ada", uuid: "{me}" },
    repository: { full_name: "Acme/Rocket" },
    links: { html: { href: "https://bitbucket.org/acme/rocket/issues/3/fix-the-thing" } },
    created_on: "2026-07-10T09:00:00.000000+00:00",
    updated_on: "2026-07-17T10:30:00.000000+00:00",
    ...over,
  };
}

function prPayload(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: "Add the thing",
    description: "why",
    state: "OPEN",
    author: { nickname: "ada" },
    source: {
      branch: { name: "feature/x" },
      commit: { hash: "deadbeef" },
      repository: { full_name: "acme/rocket" },
    },
    destination: {
      branch: { name: "main" },
      repository: { full_name: "acme/rocket" },
    },
    links: { html: { href: "https://bitbucket.org/acme/rocket/pull-requests/7" } },
    created_on: "2026-07-10T09:00:00.000000+00:00",
    updated_on: "2026-07-17T10:30:00.000000+00:00",
    ...over,
  };
}

describe("mapBitbucketIssue", () => {
  it("maps a full payload, qualifying the id with the repo and normalizing timestamps", () => {
    expect(mapBitbucketIssue(issuePayload(), "acc-1")).toEqual({
      id: "bitbucket:acme/rocket#3",
      kind: "issue",
      source: "bitbucket",
      sourceRef: { project: "Acme/Rocket", key: "3" },
      codeHost: "bitbucket",
      accountId: "acc-1",
      repo: { owner: "Acme", name: "Rocket" },
      key: "3",
      number: 3,
      title: "Fix the thing",
      body: "body text",
      labels: [],
      assignees: ["ada"],
      author: "bob",
      url: "https://bitbucket.org/acme/rocket/issues/3/fix-the-thing",
      createdAt: "2026-07-10T09:00:00.000Z",
      updatedAt: "2026-07-17T10:30:00.000Z",
      state: "open",
    });
  });

  it("treats new/open/on hold as open and the four resolutions plus closed as closed", () => {
    const stateOf = (state: string) => mapBitbucketIssue(issuePayload({ state }), "acc-1").state;
    expect(["new", "open", "on hold"].map(stateOf)).toEqual(["open", "open", "open"]);
    expect(["resolved", "invalid", "duplicate", "wontfix", "closed"].map(stateOf)).toEqual([
      "closed",
      "closed",
      "closed",
      "closed",
      "closed",
    ]);
  });

  it("synthesizes the url when the payload carries no html link", () => {
    const issue = mapBitbucketIssue(issuePayload({ links: undefined }), "acc-1");
    expect(issue.url).toBe("https://bitbucket.org/Acme/Rocket/issues/3");
  });

  it("falls the author/assignee name back through display_name and uuid", () => {
    const issue = mapBitbucketIssue(
      issuePayload({ reporter: { display_name: "Bob B" }, assignee: { uuid: "{u}" } }),
      "acc-1",
    );
    expect(issue.author).toBe("Bob B");
    expect(issue.assignees).toEqual(["{u}"]);
  });

  it("leaves an unassigned issue with no assignees and an empty body undefined", () => {
    const issue = mapBitbucketIssue(
      issuePayload({ assignee: null, content: { raw: "" } }),
      "acc-1",
    );
    expect(issue.assignees).toEqual([]);
    expect(issue.body).toBeUndefined();
  });
});

describe("mapBitbucketPullRequest", () => {
  it("maps an open PR with its refs and head sha", () => {
    expect(mapBitbucketPullRequest(prPayload(), "acc-1")).toEqual({
      id: "bitbucket:acme/rocket!7",
      kind: "pull-request",
      source: "bitbucket",
      sourceRef: { project: "acme/rocket", key: "7" },
      codeHost: "bitbucket",
      accountId: "acc-1",
      repo: { owner: "acme", name: "rocket" },
      key: "7",
      number: 7,
      title: "Add the thing",
      body: "why",
      labels: [],
      assignees: [],
      author: "ada",
      url: "https://bitbucket.org/acme/rocket/pull-requests/7",
      createdAt: "2026-07-10T09:00:00.000Z",
      updatedAt: "2026-07-17T10:30:00.000Z",
      state: "open",
      merged: false,
      draft: false,
      headRef: "feature/x",
      baseRef: "main",
      headSha: "deadbeef",
    });
  });

  it("closes and flags merged only for MERGED", () => {
    const merged = mapBitbucketPullRequest(prPayload({ state: "MERGED" }), "acc-1");
    expect(merged).toMatchObject({ state: "closed", merged: true });
    for (const state of ["DECLINED", "SUPERSEDED"]) {
      expect(mapBitbucketPullRequest(prPayload({ state }), "acc-1")).toMatchObject({
        state: "closed",
        merged: false,
      });
    }
  });

  it("carries the draft flag through, defaulting to false", () => {
    expect(mapBitbucketPullRequest(prPayload({ draft: true }), "acc-1").draft).toBe(true);
    expect(mapBitbucketPullRequest(prPayload(), "acc-1").draft).toBe(false);
  });

  it("falls the repo back to the source side when the destination has none", () => {
    const pr = mapBitbucketPullRequest(
      prPayload({ destination: { branch: { name: "main" } } }),
      "acc-1",
    );
    expect(pr.repo).toEqual({ owner: "acme", name: "rocket" });
    expect(pr.id).toBe("bitbucket:acme/rocket!7");
  });

  it("synthesizes the url when the payload carries no html link", () => {
    const pr = mapBitbucketPullRequest(prPayload({ links: undefined }), "acc-1");
    expect(pr.url).toBe("https://bitbucket.org/acme/rocket/pull-requests/7");
  });
});
