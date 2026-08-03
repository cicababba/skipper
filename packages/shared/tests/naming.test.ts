import { describe, it, expect } from "vitest";
import { branchNamesKey, displayKey, issueBranchFor, issueSlug, repoKey, slugKey } from "../src";

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

describe("issueSlug", () => {
  it("prefixes numeric GitHub keys", () => {
    expect(issueSlug("42")).toBe("issue-42");
  });

  it("leaves tracker keys unprefixed — they already carry their project id", () => {
    expect(issueSlug("PROJ-123")).toBe("proj-123");
  });

  it("does not duplicate the prefix for a project literally named ISSUE (#306)", () => {
    expect(issueSlug("ISSUE-1")).toBe("issue-1");
  });

  it("preserves slugKey sanitization", () => {
    expect(issueSlug("  A/B__42! ")).toBe("a-b-42");
  });
});

describe("issueBranchFor", () => {
  it("is byte-identical to the pre-#71 scheme for GitHub keys", () => {
    expect(issueBranchFor("42")).toBe("feature/issue-42");
  });

  it("produces a valid ref for Jira keys", () => {
    expect(issueBranchFor("PROJ-123")).toBe("feature/proj-123");
  });

  it("does not duplicate the prefix for an ISSUE-* key (#306)", () => {
    expect(issueBranchFor("ISSUE-1")).toBe("feature/issue-1");
  });
});

describe("branchNamesKey", () => {
  it("matches exactly", () => {
    expect(branchNamesKey("feature/issue-42", "42")).toBe(true);
    expect(branchNamesKey("feature/proj-123", "PROJ-123")).toBe(true);
  });

  it("matches human branches with a description suffix", () => {
    expect(branchNamesKey("feature/issue-71-two-axis-workitem", "71")).toBe(true);
    expect(branchNamesKey("feature/proj-123-fix-login", "PROJ-123")).toBe(true);
  });

  it("still matches legacy issue-prefixed branches", () => {
    expect(branchNamesKey("feature/issue-proj-123", "PROJ-123")).toBe(true);
    expect(branchNamesKey("fix/issue-proj-123", "PROJ-123")).toBe(true);
  });

  it("rejects keys that are only a string prefix", () => {
    expect(branchNamesKey("feature/issue-71-x", "7")).toBe(false);
    expect(branchNamesKey("feature/proj-123", "PROJ-12")).toBe(false);
  });

  it("ignores branches outside the convention", () => {
    expect(branchNamesKey("feature/random-work", "42")).toBe(false);
    expect(branchNamesKey("main", "42")).toBe(false);
  });

  // Numeric keys accept only the issue- form, so an unrelated feature branch
  // that happens to start with a digit never auto-links to that issue.
  it("rejects a bare numeric leaf for a numeric key", () => {
    expect(branchNamesKey("feature/1-click-checkout", "1")).toBe(false);
  });
});

describe("repoKey", () => {
  it("lowercases the partition key", () => {
    expect(repoKey({ owner: "OctoCat", name: "Demo" })).toBe("octocat/demo");
  });
});
