import { describe, it, expect } from "vitest";
import {
  codeHosts,
  codeHostFor,
  codeHostForProvider,
  issueSources,
  issueSourceFor,
  issueSourceForAuthProvider,
} from "../src/adapters";
import { bitbucketCodeHost, bitbucketIssueSource } from "../src/adapters/bitbucket";
import { githubCodeHost, githubIssueSource } from "../src/adapters/github";
import { gitlabCodeHost, gitlabIssueSource } from "../src/adapters/gitlab";
import { jiraIssueSource } from "../src/adapters/jira";
import { openprojectIssueSource } from "../src/adapters/openproject";

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

  it("registers the OpenProject adapter under its self-declared platform", () => {
    expect(issueSources.openproject).toBe(openprojectIssueSource);
    expect(openprojectIssueSource.id).toBe("openproject");
    expect(openprojectIssueSource.authProvider).toBe("openproject");
    expect(issueSourceFor("openproject")).toBe(openprojectIssueSource);
  });

  it("registers the Bitbucket adapter under its self-declared platform (#274)", () => {
    expect(issueSources.bitbucket).toBe(bitbucketIssueSource);
    expect(bitbucketIssueSource.id).toBe("bitbucket");
    expect(bitbucketIssueSource.authProvider).toBe("bitbucket");
    expect(issueSourceFor("bitbucket")).toBe(bitbucketIssueSource);
  });

  it("leaves Bitbucket without closeIssue and fetchDependencies (future work)", () => {
    expect(bitbucketIssueSource.closeIssue).toBeUndefined();
    expect(bitbucketIssueSource.fetchDependencies).toBeUndefined();
    expect(typeof bitbucketIssueSource.fetchComments).toBe("function");
  });

  it("resolves an issue source from the auth provider", () => {
    expect(issueSourceForAuthProvider("github")).toBe(githubIssueSource);
    expect(issueSourceForAuthProvider("gitlab")).toBe(gitlabIssueSource);
    expect(issueSourceForAuthProvider("jira")).toBe(jiraIssueSource);
    expect(issueSourceForAuthProvider("openproject")).toBe(openprojectIssueSource);
  });

  it("returns undefined for identity-only providers", () => {
    expect(issueSourceForAuthProvider("google")).toBeUndefined();
  });

  it("exposes fetchDependencies on GitHub but not GitLab, Jira, or OpenProject (#85)", () => {
    expect(typeof githubIssueSource.fetchDependencies).toBe("function");
    expect(gitlabIssueSource.fetchDependencies).toBeUndefined();
    expect(jiraIssueSource.fetchDependencies).toBeUndefined();
    expect(openprojectIssueSource.fetchDependencies).toBeUndefined();
  });

  it("exposes closeIssue on GitHub and GitLab but not Jira or OpenProject (#132)", () => {
    expect(typeof githubIssueSource.closeIssue).toBe("function");
    expect(typeof gitlabIssueSource.closeIssue).toBe("function");
    expect(jiraIssueSource.closeIssue).toBeUndefined();
    expect(openprojectIssueSource.closeIssue).toBeUndefined();
  });

  it("exposes createIssue on every source (#274)", () => {
    expect(typeof githubIssueSource.createIssue).toBe("function");
    expect(typeof gitlabIssueSource.createIssue).toBe("function");
    expect(typeof jiraIssueSource.createIssue).toBe("function");
    expect(typeof openprojectIssueSource.createIssue).toBe("function");
    expect(typeof bitbucketIssueSource.createIssue).toBe("function");
  });

  it("exposes fetchComments on the OpenProject adapter (#144)", () => {
    expect(typeof openprojectIssueSource.fetchComments).toBe("function");
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

  it("registers the Bitbucket adapter under its self-declared platform", () => {
    expect(codeHosts.bitbucket).toBe(bitbucketCodeHost);
    expect(bitbucketCodeHost.id).toBe("bitbucket");
    expect(bitbucketCodeHost.authProvider).toBe("bitbucket");
    expect(codeHostFor("bitbucket")).toBe(bitbucketCodeHost);
  });

  it("declares draft support per host — GitHub and GitLab yes, Bitbucket no", () => {
    expect(githubCodeHost.supportsDraft).toBe(true);
    expect(gitlabCodeHost.supportsDraft).toBe(true);
    expect(bitbucketCodeHost.supportsDraft).toBe(false);
  });

  it("resolves a code host from the auth provider", () => {
    expect(codeHostForProvider("bitbucket")).toBe("bitbucket");
    expect(codeHostForProvider("github")).toBe("github");
    expect(codeHostForProvider("jira")).toBeUndefined();
    expect(codeHostForProvider("openproject")).toBeUndefined();
  });

  it("resolves the Bitbucket issue source from its auth provider (#274)", () => {
    expect(issueSourceForAuthProvider("bitbucket")).toBe(bitbucketIssueSource);
  });
});
