import { describe, it, expect } from "vitest";
import {
  codeHosts,
  codeHostFor,
  issueSources,
  issueSourceFor,
  issueSourceForAuthProvider,
} from "../src/adapters";
import { githubCodeHost, githubIssueSource } from "../src/adapters/github";
import { gitlabIssueSource } from "../src/adapters/gitlab";

describe("issue-source registry", () => {
  it("registers the GitHub adapter under its self-declared platform", () => {
    expect(issueSources.github).toBe(githubIssueSource);
    expect(githubIssueSource.id).toBe("github");
    expect(issueSourceFor("github")).toBe(githubIssueSource);
  });

  it("registers the GitLab adapter under its self-declared platform", () => {
    expect(issueSources.gitlab).toBe(gitlabIssueSource);
    expect(gitlabIssueSource.id).toBe("gitlab");
    expect(issueSourceFor("gitlab")).toBe(gitlabIssueSource);
  });

  it("resolves an issue source from the auth provider", () => {
    expect(issueSourceForAuthProvider("github")).toBe(githubIssueSource);
    expect(issueSourceForAuthProvider("gitlab")).toBe(gitlabIssueSource);
  });

  it("returns undefined for identity-only providers", () => {
    expect(issueSourceForAuthProvider("google")).toBeUndefined();
  });
});

describe("code-host registry", () => {
  it("registers the GitHub adapter under its self-declared platform", () => {
    expect(codeHosts.github).toBe(githubCodeHost);
    expect(githubCodeHost.id).toBe("github");
    expect(githubCodeHost.authProvider).toBe("github");
    expect(codeHostFor("github")).toBe(githubCodeHost);
  });

  it("throws for a widened host without a CodeHost adapter (GitLab, #76)", () => {
    expect(() => codeHostFor("gitlab")).toThrow("no CodeHost adapter for gitlab");
  });
});
