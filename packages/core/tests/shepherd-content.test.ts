import { describe, it, expect } from "vitest";
import type { IssuePlan } from "@skipper/shared";
import { buildCommitMessage, buildIssueLink, buildPrBody, buildPrTitle } from "../src/shepherd";
import type { IssueLinkItem } from "../src/shepherd";
import { bitbucketCodeHost } from "../src/adapters/bitbucket";
import { githubCodeHost } from "../src/adapters/github";
import { gitlabCodeHost } from "../src/adapters/gitlab";

const plan: IssuePlan = {
  summary: "Introduce a theme context and toggle.",
  files: [{ path: "src/theme.ts", reason: "new theme context", status: "new" }],
  steps: [{ title: "Create theme context", detail: "d", files: [], symbols: [] }],
  acceptance: [
    { criterion: "toggle persists", addressedBy: "localStorage" },
    { criterion: "no FOUC", addressedBy: "inline script" },
  ],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
};

describe("buildCommitMessage", () => {
  it("uses the issue title and number", () => {
    expect(buildCommitMessage({ title: "Add dark mode", key: "42" })).toBe("Add dark mode (#42)");
  });
});

describe("buildPrTitle", () => {
  it("is the issue title", () => {
    expect(buildPrTitle({ title: "Add dark mode" })).toBe("Add dark mode");
  });
});

describe("buildPrBody", () => {
  it("includes the issue link, the plan summary and acceptance criteria", () => {
    const body = buildPrBody({ issueLink: "Closes #42", plan });
    expect(body).toContain("Closes #42");
    expect(body).toContain("Introduce a theme context and toggle.");
    expect(body).toContain("- toggle persists");
    expect(body).toContain("- no FOUC");
  });

  it("works without a plan", () => {
    const body = buildPrBody({ issueLink: "Closes #42" });
    expect(body).toContain("Closes #42");
    expect(body).not.toContain("## Plan");
  });
});

function linkItem(over: Partial<IssueLinkItem> = {}): IssueLinkItem {
  return {
    source: "github",
    codeHost: "github",
    sourceRef: { project: "acme/app", key: "42" },
    repo: { owner: "acme", name: "app" },
    key: "42",
    url: "https://github.com/acme/app/issues/42",
    ...over,
  };
}

describe("buildIssueLink (#299)", () => {
  it("uses the native closing keyword when the issue is in the PR's own repo", () => {
    expect(buildIssueLink(linkItem(), githubCodeHost)).toBe("Closes #42");
  });

  it("matches the project case-insensitively", () => {
    const item = linkItem({
      sourceRef: { project: "Acme/App", key: "42" },
      repo: { owner: "acme", name: "app" },
    });
    expect(buildIssueLink(item, githubCodeHost)).toBe("Closes #42");
  });

  it("falls back to the URL form for a same-host tracker project outside the repo", () => {
    const item = linkItem({
      sourceRef: { project: "acme/issues", key: "42" },
      url: "https://github.com/acme/issues/issues/42",
    });
    expect(buildIssueLink(item, githubCodeHost)).toBe("Closes https://github.com/acme/issues/issues/42");
  });

  it("uses the URL form for a cross-project GitLab issue", () => {
    const item = linkItem({
      source: "gitlab",
      codeHost: "gitlab",
      sourceRef: { project: "group/sub/tracker", key: "7" },
      repo: { owner: "group/sub", name: "app" },
      key: "7",
      url: "https://gitlab.com/group/sub/tracker/-/issues/7",
    });
    expect(buildIssueLink(item, gitlabCodeHost)).toBe(
      "Closes https://gitlab.com/group/sub/tracker/-/issues/7",
    );
  });

  it("emits a plain tracker reference for a Jira issue on a GitHub repo", () => {
    const item = linkItem({
      source: "jira",
      sourceRef: { project: "PROJ", key: "PROJ-7" },
      key: "PROJ-7",
      url: "https://acme.atlassian.net/browse/PROJ-7",
    });
    expect(buildIssueLink(item, githubCodeHost)).toBe(
      "Tracker issue: https://acme.atlassian.net/browse/PROJ-7",
    );
  });

  it("emits a plain tracker reference for an OpenProject issue on a GitLab repo — a numeric key would otherwise read as a native ref", () => {
    const item = linkItem({
      source: "openproject",
      codeHost: "gitlab",
      sourceRef: { project: "12", key: "1234" },
      key: "1234",
      url: "https://op.acme.dev/work_packages/1234",
    });
    expect(buildIssueLink(item, gitlabCodeHost)).toBe(
      "Tracker issue: https://op.acme.dev/work_packages/1234",
    );
  });

  it("uses Bitbucket's non-closing keyword in both same-repo and cross-project shapes", () => {
    const same = linkItem({ source: "bitbucket", codeHost: "bitbucket" });
    expect(buildIssueLink(same, bitbucketCodeHost)).toBe("Refs 42");

    const cross = linkItem({
      source: "bitbucket",
      codeHost: "bitbucket",
      sourceRef: { project: "acme/tracker", key: "42" },
      url: "https://bitbucket.org/acme/tracker/issues/42",
    });
    expect(buildIssueLink(cross, bitbucketCodeHost)).toBe(
      "Refs https://bitbucket.org/acme/tracker/issues/42",
    );
  });
});
