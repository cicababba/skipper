import { describe, it, expect } from "vitest";
import type { Issue } from "@skipper/shared";
import { projectMappingKey } from "@skipper/shared";
import { resolveProjectRepos } from "../src/orchestrator";

const HOST = "acme.atlassian.net";

function jiraIssue(key: string, project: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id: `jira:${key}`,
    kind: "issue",
    source: "jira",
    sourceRef: { project, key },
    codeHost: "github",
    accountId: "acct-1",
    key,
    title: `Issue ${key}`,
    labels: [],
    assignees: [],
    url: `https://${HOST}/browse/${key}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

const target = { accountId: "acct-1", host: HOST };

describe("resolveProjectRepos", () => {
  it("passes repo-carrying issues through untouched", () => {
    const gh = jiraIssue("1", "PROJ", { source: "github", repo: { owner: "o", name: "r" } });
    const { issues, unmapped } = resolveProjectRepos([gh], target, {});
    expect(issues[0]).toBe(gh);
    expect(unmapped).toEqual([]);
  });

  it("fills repo from the mapping for a repo-less issue", () => {
    const mappings = { [projectMappingKey("jira", HOST, "PROJ")]: "octo/demo" };
    const { issues, unmapped } = resolveProjectRepos([jiraIssue("PROJ-1", "PROJ")], target, mappings);
    expect(issues[0].repo).toEqual({ owner: "octo", name: "demo" });
    expect(unmapped).toEqual([]);
  });

  it("counts an issue with no mapping as unmapped", () => {
    const { issues, unmapped } = resolveProjectRepos([jiraIssue("PROJ-1", "PROJ")], target, {});
    expect(issues[0].repo).toBeUndefined();
    expect(unmapped).toEqual([
      { source: "jira", host: HOST, projectKey: "PROJ", count: 1, accountId: "acct-1" },
    ]);
  });

  it("treats a malformed mapping value as unmapped", () => {
    const mappings = { [projectMappingKey("jira", HOST, "PROJ")]: "no-slash" };
    const { issues, unmapped } = resolveProjectRepos([jiraIssue("PROJ-1", "PROJ")], target, mappings);
    expect(issues[0].repo).toBeUndefined();
    expect(unmapped[0]).toMatchObject({ projectKey: "PROJ", count: 1 });
  });

  it("counts only open issues", () => {
    const closed = jiraIssue("PROJ-2", "PROJ", { state: "closed" });
    const { unmapped } = resolveProjectRepos([closed], target, {});
    expect(unmapped).toEqual([]);
  });

  it("aggregates the count per project", () => {
    const issues = [
      jiraIssue("PROJ-1", "PROJ"),
      jiraIssue("PROJ-2", "PROJ"),
      jiraIssue("OPS-1", "OPS"),
    ];
    const { unmapped } = resolveProjectRepos(issues, target, {});
    const proj = unmapped.find((u) => u.projectKey === "PROJ");
    const ops = unmapped.find((u) => u.projectKey === "OPS");
    expect(proj?.count).toBe(2);
    expect(ops?.count).toBe(1);
  });
});
