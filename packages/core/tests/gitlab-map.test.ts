import { describe, it, expect } from "vitest";
import {
  repoFromPayload,
  repoRefFromPath,
  mapIssue,
  mapMergeRequest,
  ciStatusFromPipeline,
  deriveGitLabReviewDecision,
  type GitLabIssuePayload,
  type GitLabMrPayload,
} from "../src/adapters/gitlab/map";

function issuePayload(overrides: Partial<GitLabIssuePayload> = {}): GitLabIssuePayload {
  return {
    id: 500,
    iid: 12,
    title: "Issue",
    description: "body",
    web_url: "https://gitlab.com/group/sub/rocket/-/issues/12",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    labels: ["bug"],
    assignees: [{ username: "alice" }],
    author: { username: "bob" },
    references: { full: "group/sub/rocket#12" },
    state: "opened",
    ...overrides,
  };
}

describe("gitlab map", () => {
  it("derives a nested-group repo from references.full", () => {
    expect(repoFromPayload(issuePayload(), "#")).toEqual({ owner: "group/sub", name: "rocket" });
  });

  it("falls back to web_url when references.full is absent", () => {
    const repo = repoFromPayload(
      issuePayload({ references: undefined, web_url: "https://gitlab.com/group/rocket/-/issues/12" }),
      "#",
    );
    expect(repo).toEqual({ owner: "group", name: "rocket" });
  });

  it("splits a path into owner (nested) and name", () => {
    expect(repoRefFromPath("a/b/c")).toEqual({ owner: "a/b", name: "c" });
    expect(repoRefFromPath("solo")).toEqual({ owner: "", name: "solo" });
  });

  it("maps an issue with opened → open state and null description → undefined", () => {
    const issue = mapIssue(issuePayload({ description: null }), "acct");
    expect(issue.id).toBe("gitlab:500");
    expect(issue.key).toBe("12");
    expect(issue.state).toBe("open");
    expect(issue.body).toBeUndefined();
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.assignees).toEqual(["alice"]);
  });

  it("maps merge-request states: merged, closed, locked-as-open", () => {
    const mr = (state: GitLabMrPayload["state"]) =>
      mapMergeRequest(
        {
          ...issuePayload({ references: { full: "group/sub/rocket!12" } }),
          state,
          source_branch: "feature/x",
          target_branch: "develop",
          sha: "sha1",
          merge_status: "can_be_merged",
        } as GitLabMrPayload,
        "acct",
      );
    expect(mr("merged")).toMatchObject({ merged: true, state: "closed" });
    expect(mr("closed")).toMatchObject({ merged: false, state: "closed" });
    expect(mr("locked")).toMatchObject({ merged: false, state: "open" }); // transient
    const open = mr("opened");
    expect(open).toMatchObject({ state: "open", headRef: "feature/x", baseRef: "develop", mergeable: true });
  });

  it("maps merge_status to mergeable tri-state", () => {
    const mk = (merge_status: string) =>
      mapMergeRequest(
        {
          ...issuePayload({ references: { full: "g/r!1" } }),
          state: "opened",
          source_branch: "a",
          target_branch: "b",
          merge_status,
        } as GitLabMrPayload,
        "acct",
      ).mergeable;
    expect(mk("can_be_merged")).toBe(true);
    expect(mk("cannot_be_merged")).toBe(false);
    expect(mk("cannot_be_merged_recheck")).toBe(false);
    expect(mk("checking")).toBeUndefined();
  });

  it("maps pipeline status enums to ciStatus", () => {
    expect(ciStatusFromPipeline("success")).toBe("passing");
    expect(ciStatusFromPipeline("failed")).toBe("failing");
    expect(ciStatusFromPipeline("canceled")).toBe("failing");
    expect(ciStatusFromPipeline("running")).toBe("pending");
    expect(ciStatusFromPipeline("scheduled")).toBe("pending");
    expect(ciStatusFromPipeline("skipped")).toBeUndefined();
    expect(ciStatusFromPipeline("manual")).toBeUndefined();
    expect(ciStatusFromPipeline(undefined)).toBeUndefined();
  });

  it("derives review decision: unresolved threads beat approval; approvals_left is authoritative", () => {
    expect(deriveGitLabReviewDecision({ approvals_left: 0 }, true)).toBe("changes-requested");
    expect(deriveGitLabReviewDecision({ approvals_left: 0 }, false)).toBe("approved");
    expect(deriveGitLabReviewDecision({ approvals_left: 2 }, false)).toBe("review-required");
    // approvals_left absent → fall back to the `approved` flag.
    expect(deriveGitLabReviewDecision({ approved: true }, false)).toBe("approved");
    expect(deriveGitLabReviewDecision({ approved: false }, false)).toBe("review-required");
    expect(deriveGitLabReviewDecision(undefined, false)).toBe("review-required");
  });
});
