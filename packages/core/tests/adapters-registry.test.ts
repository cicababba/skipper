import { describe, it, expect } from "vitest";
import {
  codeHosts,
  codeHostFor,
  issueSources,
  issueSourceFor,
  issueSourceForAuthProvider,
} from "../src/adapters";
import { githubCodeHost, githubIssueSource } from "../src/adapters/github";
import { gitlabCodeHost, gitlabIssueSource } from "../src/adapters/gitlab";
import { jiraIssueSource } from "../src/adapters/jira";

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

  it("registers the Jira adapter under its self-declared platform", () => {
    expect(issueSources.jira).toBe(jiraIssueSource);
    expect(jiraIssueSource.id).toBe("jira");
    expect(issueSourceFor("jira")).toBe(jiraIssueSource);
  });

  it("resolves an issue source from the auth provider", () => {
    expect(issueSourceForAuthProvider("github")).toBe(githubIssueSource);
    expect(issueSourceForAuthProvider("gitlab")).toBe(gitlabIssueSource);
    expect(issueSourceForAuthProvider("jira")).toBe(jiraIssueSource);
  });

  it("returns undefined for identity-only providers", () => {
    expect(issueSourceForAuthProvider("google")).toBeUndefined();
  });

  it("exposes fetchDependencies on GitHub but not GitLab or Jira (#85)", () => {
    expect(typeof githubIssueSource.fetchDependencies).toBe("function");
    expect(gitlabIssueSource.fetchDependencies).toBeUndefined();
    expect(jiraIssueSource.fetchDependencies).toBeUndefined();
  });
});

describe("code-host registry", () => {
  it("registers the GitHub adapter under its self-declared platform", () => {
    expect(codeHosts.github).toBe(githubCodeHost);
    expect(githubCodeHost.id).toBe("github");
    expect(githubCodeHost.authProvider).toBe("github");
    expect(codeHostFor("github")).toBe(githubCodeHost);
  });

  it("registers the GitLab adapter under its self-declared platform", () => {
    expect(codeHosts.gitlab).toBe(gitlabCodeHost);
    expect(gitlabCodeHost.id).toBe("gitlab");
    expect(gitlabCodeHost.authProvider).toBe("gitlab");
    expect(codeHostFor("gitlab")).toBe(gitlabCodeHost);
  });
});
