import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR_SETTINGS, type OrchestratorManifest } from "@skipper/core";
import type { Issue, LifecycleState, RepoIntakeSettings, TrackedItem } from "@skipper/shared";
import {
  activeItemsForRepo,
  applyRepoFollowed,
  guardFollowedPatch,
  markRepoFollowed,
} from "./repo-follow";

const REPO = { owner: "Octo", name: "Demo" };

function tracked(id: string, state: LifecycleState, repo = REPO): TrackedItem {
  return {
    id,
    source: "github",
    sourceRef: { project: `${repo.owner}/${repo.name}`, key: id },
    codeHost: "github",
    accountId: "github:1",
    repo,
    key: id,
    title: `item ${id}`,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${id}`,
    state,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    transitions: [],
  };
}

function cached(id: string, repo = REPO): Issue {
  return {
    kind: "issue",
    id,
    source: "github",
    sourceRef: { project: `${repo.owner}/${repo.name}`, key: id },
    codeHost: "github",
    accountId: "github:1",
    repo,
    key: id,
    title: `issue ${id}`,
    labels: [],
    assignees: [],
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${id}`,
    state: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function manifest(patch: Partial<OrchestratorManifest> = {}): OrchestratorManifest {
  return {
    version: 3,
    settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS },
    items: {},
    parked: {},
    repoSettings: {},
    projectMappings: {},
    ...patch,
  };
}

describe("activeItemsForRepo", () => {
  it("returns only the repo's non-settled items", () => {
    const m = manifest({
      items: {
        a: tracked("a", "merged"),
        b: tracked("b", "closed"),
        c: tracked("c", "plan-gate"),
        d: tracked("d", "coding"),
        e: tracked("e", "coding", { owner: "other", name: "repo" }),
      },
    });
    expect(activeItemsForRepo(m, "octo/demo").map((i) => i.id)).toEqual(["c", "d"]);
  });

  it("matches the repo case-insensitively", () => {
    const m = manifest({ items: { a: tracked("a", "queued", { owner: "OCTO", name: "DEMO" }) } });
    expect(activeItemsForRepo(m, "octo/demo")).toHaveLength(1);
  });
});

describe("applyRepoFollowed", () => {
  it("writes an explicit followed:true", () => {
    const m = manifest();
    expect(applyRepoFollowed(m, REPO, true, [])).toEqual({ ok: true, changed: true });
    expect(m.repoSettings["octo/demo"]).toEqual({ followed: true });
  });

  it("keeps the repo's other settings when following", () => {
    const m = manifest({ repoSettings: { "octo/demo": { priority: "high" } } });
    applyRepoFollowed(m, REPO, true, []);
    expect(m.repoSettings["octo/demo"]).toEqual({ priority: "high", followed: true });
  });

  it("reports changed:false when the flag already holds", () => {
    const m = manifest({ repoSettings: { "octo/demo": { followed: true } } });
    expect(applyRepoFollowed(m, REPO, true, [])).toEqual({ ok: true, changed: false });
  });

  it("unfollows a repo whose items are all merged or closed", () => {
    const m = manifest({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", "merged"), b: tracked("b", "closed") },
    });
    expect(applyRepoFollowed(m, REPO, false, [])).toEqual({ ok: true, changed: true });
    expect(m.repoSettings["octo/demo"]).toEqual({ followed: false });
  });

  it.each([
    "triage",
    "planning",
    "plan-gate",
    "queued",
    "coding",
    "agent-review",
    "human-review",
    "pr-open",
    "in-review",
    "changes-requested",
    "needs-input",
    "blocked",
    "failed",
  ] as const)("refuses to unfollow while an item is %s", (state) => {
    const m = manifest({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", state) },
    });
    const result = applyRepoFollowed(m, REPO, false, []);
    expect(result).toEqual({
      ok: false,
      error: "Octo/Demo still has 1 active item",
      blocking: [{ id: "a", key: "a", state }],
    });
    expect(m.repoSettings["octo/demo"]).toEqual({ followed: true });
  });

  it("names every blocking item", () => {
    const m = manifest({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", "coding"), b: tracked("b", "merged"), c: tracked("c", "blocked") },
    });
    const result = applyRepoFollowed(m, REPO, false, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Octo/Demo still has 2 active items");
    expect(result.blocking.map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("purges the repo's parked entries on unfollow, resolved through the poll cache", () => {
    const m = manifest({
      repoSettings: { "octo/demo": { followed: true } },
      parked: {
        "github:1": { firstSeenAt: "2026-07-01T00:00:00.000Z" },
        "github:2": { firstSeenAt: "2026-07-01T00:00:00.000Z" },
        "github:3": { firstSeenAt: "2026-07-01T00:00:00.000Z" },
      },
    });
    const cache = [
      cached("github:1"),
      cached("github:2", { owner: "other", name: "repo" }),
      { id: "github:4", repo: REPO },
    ];
    expect(applyRepoFollowed(m, REPO, false, cache).ok).toBe(true);
    // github:3 is absent from the cache — it could never be admitted anyway.
    expect(Object.keys(m.parked)).toEqual(["github:2", "github:3"]);
  });

  it("leaves parked entries alone when following", () => {
    const m = manifest({ parked: { "github:1": { firstSeenAt: "2026-07-01T00:00:00.000Z" } } });
    applyRepoFollowed(m, REPO, true, [cached("github:1")]);
    expect(Object.keys(m.parked)).toEqual(["github:1"]);
  });
});

describe("markRepoFollowed", () => {
  it("follows the repo without touching its other settings", () => {
    const m = manifest({ repoSettings: { "octo/demo": { priority: "low" } } });
    markRepoFollowed(m, REPO);
    expect(m.repoSettings["octo/demo"]).toEqual({ priority: "low", followed: true });
  });
});

describe("guardFollowedPatch", () => {
  const merge = (m: OrchestratorManifest, merged: RepoIntakeSettings) =>
    guardFollowedPatch(m, "octo/demo", merged);

  it("keeps a blocked repo followed while applying the rest of the patch", () => {
    const m = manifest({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", "coding") },
    });
    expect(merge(m, { followed: false, priority: "high" })).toEqual({
      followed: true,
      priority: "high",
    });
  });

  // An absent `followed` key now means "not followed", so clearing the override
  // is an unfollow too — the guard has to catch it, not just an explicit false.
  it("catches an unfollow spelled as a cleared override", () => {
    const m = manifest({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", "plan-gate") },
    });
    expect(merge(m, { priority: "low" })).toEqual({ followed: true, priority: "low" });
  });

  it("lets the unfollow through when nothing is active", () => {
    const m = manifest({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", "merged") },
    });
    expect(merge(m, { followed: false })).toEqual({ followed: false });
  });

  it("never forces a follow on a repo that was not followed", () => {
    const m = manifest({ items: { a: tracked("a", "coding") } });
    expect(merge(m, { priority: "high" })).toEqual({ priority: "high" });
  });

  it("leaves a patch that keeps the repo followed untouched", () => {
    const m = manifest({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", "coding") },
    });
    expect(merge(m, { followed: true, wipLimit: 3 })).toEqual({ followed: true, wipLimit: 3 });
  });
});
