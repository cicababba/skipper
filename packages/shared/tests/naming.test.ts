import { describe, it, expect } from "vitest";
import {
  BRANCH_ISSUE_RE,
  branchSlugMatchesKey,
  displayKey,
  issueBranchFor,
  repoKey,
  slugKey,
} from "../src";

describe("slugKey", () => {
  it("keeps numeric GitHub keys verbatim", () => {
    expect(slugKey("42")).toBe("42");
  });

  it("lowercases and dashes Jira keys", () => {
    expect(slugKey("PROJ-123")).toBe("proj-123");
  });

  it("collapses runs of non-alphanumerics and trims dashes", () => {
    expect(slugKey("  A/B__42! ")).toBe("a-b-42");
  });
});

describe("displayKey", () => {
  it("prefixes bare numbers with #", () => {
    expect(displayKey("42")).toBe("#42");
  });

  it("leaves tracker keys verbatim", () => {
    expect(displayKey("PROJ-123")).toBe("PROJ-123");
  });
});

describe("issueBranchFor", () => {
  it("is byte-identical to the pre-#71 scheme for GitHub keys", () => {
    expect(issueBranchFor("42")).toBe("feature/issue-42");
  });

  it("produces a valid ref for Jira keys", () => {
    expect(issueBranchFor("PROJ-123")).toBe("feature/issue-proj-123");
  });
});

describe("BRANCH_ISSUE_RE", () => {
  it("captures the whole slug tail", () => {
    expect(BRANCH_ISSUE_RE.exec("feature/issue-42")?.[1]).toBe("42");
    expect(BRANCH_ISSUE_RE.exec("feature/issue-71-two-axis-workitem")?.[1]).toBe(
      "71-two-axis-workitem",
    );
    expect(BRANCH_ISSUE_RE.exec("fix/issue-proj-123")?.[1]).toBe("proj-123");
  });

  it("ignores branches outside the convention", () => {
    expect(BRANCH_ISSUE_RE.exec("feature/random-work")).toBeNull();
    expect(BRANCH_ISSUE_RE.exec("main")).toBeNull();
  });
});

describe("branchSlugMatchesKey", () => {
  it("matches exactly", () => {
    expect(branchSlugMatchesKey("42", "42")).toBe(true);
    expect(branchSlugMatchesKey("proj-123", "PROJ-123")).toBe(true);
  });

  it("matches human branches with a description suffix", () => {
    expect(branchSlugMatchesKey("71-two-axis-workitem", "71")).toBe(true);
    expect(branchSlugMatchesKey("proj-123-fix-login", "PROJ-123")).toBe(true);
  });

  it("rejects keys that are only a string prefix", () => {
    expect(branchSlugMatchesKey("71-x", "7")).toBe(false);
    expect(branchSlugMatchesKey("proj-123", "PROJ-12")).toBe(false);
  });
});

describe("repoKey", () => {
  it("lowercases the partition key", () => {
    expect(repoKey({ owner: "OctoCat", name: "Demo" })).toBe("octocat/demo");
  });
});
