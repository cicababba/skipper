import { describe, it, expect } from "vitest";
import { issueSources, issueSourceFor, issueSourceForAuthProvider } from "../src/adapters";
import { githubIssueSource } from "../src/adapters/github";

describe("issue-source registry", () => {
  it("registers the GitHub adapter under its self-declared platform", () => {
    expect(issueSources.github).toBe(githubIssueSource);
    expect(githubIssueSource.platform).toBe("github");
    expect(issueSourceFor("github")).toBe(githubIssueSource);
  });

  it("resolves an issue source from the auth provider", () => {
    expect(issueSourceForAuthProvider("github")).toBe(githubIssueSource);
  });

  it("returns undefined for identity-only providers", () => {
    expect(issueSourceForAuthProvider("google")).toBeUndefined();
  });
});
