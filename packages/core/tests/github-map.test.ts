import { describe, it, expect } from "vitest";
import {
  parseRepoFromUrl,
  mapIssue,
  mapPullFromIssue,
  mapPullDetail,
  applyPullDetails,
  type GitHubIssuePayload,
  type GitHubPullPayload,
} from "../src/adapters/github/map";

function issuePayload(overrides: Partial<GitHubIssuePayload> = {}): GitHubIssuePayload {
  return {
    id: 111,
    number: 42,
    title: "Fix the bug",
    body: "details",
    state: "open",
    html_url: "https://github.com/acme/rocket/issues/42",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    labels: [{ name: "bug" }, "ready", { name: undefined }, { name: "" }],
    assignees: [{ login: "alice" }],
    user: { login: "bob" },
    repository_url: "https://api.github.com/repos/acme/rocket",
    ...overrides,
  };
}

describe("github map", () => {
  it("parses owner/name from the repository_url", () => {
    expect(parseRepoFromUrl("https://api.github.com/repos/acme/rocket")).toEqual({
      owner: "acme",
      name: "rocket",
    });
  });

  it("maps an issue, normalizing label shapes and dropping empty names", () => {
    const issue = mapIssue(issuePayload(), "acct");
    expect(issue.id).toBe("github:111");
    expect(issue.kind).toBe("issue");
    expect(issue.state).toBe("open");
    expect(issue.repo).toEqual({ owner: "acme", name: "rocket" });
    expect(issue.key).toBe("42");
    expect(issue.number).toBe(42);
    expect(issue.labels).toEqual(["bug", "ready"]);
    expect(issue.assignees).toEqual(["alice"]);
    expect(issue.author).toBe("bob");
  });

  it("coerces a null body to undefined", () => {
    expect(mapIssue(issuePayload({ body: null }), "acct").body).toBeUndefined();
  });

  it("maps a PR from an issue payload and detects merged via pull_request.merged_at", () => {
    const open = mapPullFromIssue(issuePayload({ pull_request: { merged_at: null }, draft: true }), "acct");
    expect(open.kind).toBe("pull-request");
    expect(open.merged).toBe(false);
    expect(open.draft).toBe(true);

    const merged = mapPullFromIssue(
      issuePayload({ pull_request: { merged_at: "2026-07-03T00:00:00Z" } }),
      "acct",
    );
    expect(merged.merged).toBe(true);
  });

  it("maps a full PR detail payload including refs and mergeable coercion", () => {
    const payload: GitHubPullPayload = {
      id: 999,
      number: 7,
      title: "PR",
      body: null,
      state: "open",
      merged: false,
      draft: false,
      mergeable: null,
      html_url: "https://github.com/acme/rocket/pull/7",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
      user: { login: "carol" },
      labels: [{ name: "enhancement" }],
      assignees: null,
      head: { ref: "feature/x", sha: "abc123" },
      base: { ref: "develop" },
    };
    const pr = mapPullDetail(payload, "acct", { owner: "acme", name: "rocket" });
    // id is the pull-record id, key/number are the PR number.
    expect(pr.id).toBe("github:999");
    expect(pr.key).toBe("7");
    expect(pr.headRef).toBe("feature/x");
    expect(pr.baseRef).toBe("develop");
    expect(pr.headSha).toBe("abc123");
    expect(pr.mergeable).toBeUndefined(); // null → undefined
    expect(pr.assignees).toEqual([]);
    expect(pr.labels).toEqual(["enhancement"]);
  });

  it("applyPullDetails overlays state/refs onto a list-level PR", () => {
    const base = mapPullFromIssue(issuePayload(), "acct");
    const merged = applyPullDetails(base, {
      id: 1,
      number: 42,
      title: "x",
      state: "closed",
      merged: true,
      draft: false,
      mergeable: true,
      html_url: "x",
      created_at: "x",
      updated_at: "x",
      head: { ref: "h", sha: "s" },
      base: { ref: "b" },
    });
    expect(merged.state).toBe("closed");
    expect(merged.merged).toBe(true);
    expect(merged.headRef).toBe("h");
    expect(merged.baseRef).toBe("b");
    expect(merged.headSha).toBe("s");
    expect(merged.mergeable).toBe(true);
  });
});
