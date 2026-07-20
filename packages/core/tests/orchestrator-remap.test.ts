import { describe, it, expect } from "vitest";
import type { LifecycleState, TrackedItem } from "@skipper/shared";
import { projectMappingKey } from "@skipper/shared";
import { remapProjectItems, type OrchestratorManifest } from "../src/orchestrator";

const ACCOUNT = "jira:acme.atlassian.net:1";
const HOST = "acme.atlassian.net";
const MAPPING_KEY = projectMappingKey("jira", HOST, "PROJ");
const TARGET = { repo: { owner: "new", name: "repo" }, codeHost: "github" as const };

const hostForAccount = (accountId: string): string | undefined =>
  accountId === ACCOUNT ? HOST : undefined;

function jiraItem(n: number, state: LifecycleState, extra: Partial<TrackedItem> = {}): TrackedItem {
  const key = `PROJ-${n}`;
  return {
    id: `jira:${key}`,
    source: "jira",
    sourceRef: { project: "PROJ", key },
    codeHost: "github",
    accountId: ACCOUNT,
    repo: { owner: "old", name: "repo" },
    key,
    title: `Issue ${n}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    state,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    transitions: [],
    ...extra,
  };
}

function manifest(items: TrackedItem[]): OrchestratorManifest {
  return {
    version: 1,
    settings: { intakePaused: false },
    items: Object.fromEntries(items.map((i) => [i.id, i])),
    parked: {},
    repoSettings: {},
    projectMappings: {},
  } as OrchestratorManifest;
}

describe("remapProjectItems", () => {
  it("migrates a pre-coding item with no worktree or PR", () => {
    const m = manifest([jiraItem(1, "triage")]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.migrated).toEqual(["jira:PROJ-1"]);
    expect(m.items["jira:PROJ-1"].repo).toEqual(TARGET.repo);
    expect(m.items["jira:PROJ-1"].codeHost).toBe("github");
    expect(m.items["jira:PROJ-1"].staleRepo).toBeUndefined();
  });

  it("flags an item that has a worktree", () => {
    const m = manifest([
      jiraItem(1, "queued", { worktree: { path: "/wt", branch: "b" } }),
    ]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.flaggedStale).toEqual(["jira:PROJ-1"]);
    expect(m.items["jira:PROJ-1"].repo).toEqual({ owner: "old", name: "repo" });
    expect(m.items["jira:PROJ-1"].staleRepo).toBe(true);
  });

  it("flags an item that has a PR", () => {
    const m = manifest([
      jiraItem(1, "queued", { pr: { id: "p", number: 5, url: "u" } }),
    ]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.flaggedStale).toEqual(["jira:PROJ-1"]);
    expect(m.items["jira:PROJ-1"].staleRepo).toBe(true);
  });

  it("flags a coding item", () => {
    const m = manifest([jiraItem(1, "coding")]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.flaggedStale).toEqual(["jira:PROJ-1"]);
    expect(m.items["jira:PROJ-1"].staleRepo).toBe(true);
  });

  it("is idempotent — an already-stale item is not re-flagged", () => {
    const m = manifest([jiraItem(1, "coding", { staleRepo: true })]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.flaggedStale).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.cleared).toEqual([]);
  });

  it("clears the stale flag when the repo now matches the target", () => {
    const m = manifest([
      jiraItem(1, "coding", { repo: { owner: "new", name: "repo" }, staleRepo: true }),
    ]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.cleared).toEqual(["jira:PROJ-1"]);
    expect(m.items["jira:PROJ-1"].staleRepo).toBeUndefined();
  });

  it("skips items whose account is signed out (no host)", () => {
    const m = manifest([jiraItem(1, "triage", { accountId: "gone" })]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.migrated).toEqual([]);
    expect(m.items["jira:PROJ-1"].repo).toEqual({ owner: "old", name: "repo" });
  });

  it("skips items in another project or source", () => {
    const other = jiraItem(1, "triage", {
      id: "jira:OTHER-1",
      sourceRef: { project: "OTHER", key: "OTHER-1" },
    });
    const m = manifest([other]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.migrated).toEqual([]);
    expect(m.items["jira:OTHER-1"].repo).toEqual({ owner: "old", name: "repo" });
  });

  it("leaves merged and closed items untouched", () => {
    const m = manifest([jiraItem(1, "merged"), jiraItem(2, "closed")]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.migrated).toEqual([]);
    expect(result.flaggedStale).toEqual([]);
    expect(m.items["jira:PROJ-1"].repo).toEqual({ owner: "old", name: "repo" });
    expect(m.items["jira:PROJ-2"].repo).toEqual({ owner: "old", name: "repo" });
  });

  it("compares the repo case-insensitively", () => {
    const m = manifest([
      jiraItem(1, "coding", { repo: { owner: "New", name: "Repo" }, staleRepo: true }),
    ]);
    const result = remapProjectItems(m, MAPPING_KEY, TARGET, hostForAccount);
    expect(result.cleared).toEqual(["jira:PROJ-1"]);
    expect(result.flaggedStale).toEqual([]);
  });
});
