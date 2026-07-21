import { describe, it, expect } from "vitest";
import {
  deriveBitbucketReviewDecision,
  ciStatusFromStatuses,
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
