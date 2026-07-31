import { describe, it, expect } from "vitest";
import type { LifecycleState, TrackedItem } from "@skipper/shared";
import { resolveBaseChangeActions, type WorktreeProbe } from "./base-change";

const NOW = "2026-07-21T10:00:00.000Z";

function makeItem(over: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "owner/repo", key: "1" },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "owner", name: "repo" },
    key: "1",
    number: 1,
    title: "issue 1",
    url: "https://github.com/owner/repo/issues/1",
    state: "plan-gate",
    createdAt: NOW,
    updatedAt: NOW,
    transitions: [],
    worktree: { path: "/wt/issue-1", branch: "feature/issue-1" },
    ...over,
  } as TrackedItem;
}

const clean: WorktreeProbe = { dirty: false, aheadOfOldBase: 0 };
const probesFor = (item: TrackedItem, probe: WorktreeProbe): Map<string, WorktreeProbe> =>
  new Map([[item.id, probe]]);

describe("resolveBaseChangeActions", () => {
  it("ignores items in another repo", () => {
    const mine = makeItem({ id: "github:1", state: "plan-gate" });
    const other = makeItem({
      id: "github:2",
      repo: { owner: "other", name: "repo" },
      worktree: { path: "/wt/2", branch: "b2" },
    });
    const probes = new Map<string, WorktreeProbe>([
      [mine.id, clean],
      [other.id, clean],
    ]);
    const r = resolveBaseChangeActions([mine, other], "owner/repo", probes);
    expect(r.discard.map((d) => d.id)).toEqual([mine.id]);
    expect(r.replan).toEqual([mine.id]);
    expect(r.skipped).toEqual([]);
  });

  it("leaves in-flight, PR-side and terminal states untouched", () => {
    const states: LifecycleState[] = [
      "planning",
      "coding",
      "agent-review",
      "human-review",
      "pr-open",
      "in-review",
      "changes-requested",
      "merged",
      "failed",
      "blocked",
      "closed",
    ];
    const items = states.map((state, i) =>
      makeItem({ id: `github:${i}`, state, worktree: { path: `/wt/${i}`, branch: `b${i}` } }),
    );
    const probes = new Map(items.map((it) => [it.id, clean]));
    const r = resolveBaseChangeActions(items, "owner/repo", probes);
    expect(r.discard).toEqual([]);
    expect(r.replan).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it.each(["plan-gate", "queued"] as const)(
    "discards and replans a clean, 0-ahead %s worktree",
    (state) => {
      const item = makeItem({ state });
      const r = resolveBaseChangeActions([item], "owner/repo", probesFor(item, clean));
      expect(r.discard).toEqual([
        { id: item.id, worktree: { path: "/wt/issue-1", branch: "feature/issue-1" } },
      ]);
      expect(r.replan).toEqual([item.id]);
      expect(r.skipped).toEqual([]);
    },
  );

  it("skips a dirty worktree without discarding or replanning", () => {
    const item = makeItem({ state: "plan-gate" });
    const r = resolveBaseChangeActions(
      [item],
      "owner/repo",
      probesFor(item, { dirty: true, aheadOfOldBase: 0 }),
    );
    expect(r.discard).toEqual([]);
    expect(r.replan).toEqual([]);
    expect(r.skipped).toEqual([{ id: item.id, key: "1", reason: "dirty" }]);
  });

  it("skips a worktree with its own commits (own-commits)", () => {
    const item = makeItem({ state: "queued" });
    const r = resolveBaseChangeActions(
      [item],
      "owner/repo",
      probesFor(item, { dirty: false, aheadOfOldBase: 3 }),
    );
    expect(r.discard).toEqual([]);
    expect(r.replan).toEqual([]);
    expect(r.skipped).toEqual([{ id: item.id, key: "1", reason: "own-commits" }]);
  });

  it("discards when the worktree dir is gone (dirty === null)", () => {
    const item = makeItem({ state: "plan-gate" });
    const r = resolveBaseChangeActions(
      [item],
      "owner/repo",
      probesFor(item, { dirty: null, aheadOfOldBase: null }),
    );
    expect(r.discard).toHaveLength(1);
    expect(r.replan).toEqual([item.id]);
    expect(r.skipped).toEqual([]);
  });

  it("skips when the ahead-count is unresolved (aheadOfOldBase === null)", () => {
    const item = makeItem({ state: "plan-gate" });
    const r = resolveBaseChangeActions(
      [item],
      "owner/repo",
      probesFor(item, { dirty: false, aheadOfOldBase: null }),
    );
    expect(r.discard).toEqual([]);
    expect(r.replan).toEqual([]);
    expect(r.skipped).toEqual([{ id: item.id, key: "1", reason: "unresolved-base" }]);
  });

  it("skips when the ahead-count is NaN rather than discarding the worktree", () => {
    const item = makeItem({ state: "plan-gate" });
    const r = resolveBaseChangeActions(
      [item],
      "owner/repo",
      probesFor(item, { dirty: false, aheadOfOldBase: NaN }),
    );
    expect(r.discard).toEqual([]);
    expect(r.replan).toEqual([]);
    expect(r.skipped).toEqual([{ id: item.id, key: "1", reason: "unresolved-base" }]);
  });

  it("replans a needs-input item only when it has a plan", () => {
    const withPlan = makeItem({ state: "needs-input", plan: { ref: "github_1.json" } });
    const withoutPlan = makeItem({ state: "needs-input" });
    expect(resolveBaseChangeActions([withPlan], "owner/repo", probesFor(withPlan, clean)).replan).toEqual([
      withPlan.id,
    ]);
    const noPlan = resolveBaseChangeActions([withoutPlan], "owner/repo", probesFor(withoutPlan, clean));
    expect(noPlan.discard).toHaveLength(1); // clean worktree still discarded
    expect(noPlan.replan).toEqual([]);
  });

  it("discards a triage worktree but never replans it", () => {
    const item = makeItem({ state: "triage" });
    const r = resolveBaseChangeActions([item], "owner/repo", probesFor(item, clean));
    expect(r.discard).toHaveLength(1);
    expect(r.replan).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it.each(["plan-gate", "queued"] as const)(
    "replans a worktree-less %s item without discarding",
    (state) => {
      const item = makeItem({ state, worktree: undefined });
      const r = resolveBaseChangeActions([item], "owner/repo", new Map());
      expect(r.discard).toEqual([]);
      expect(r.replan).toEqual([item.id]);
      expect(r.skipped).toEqual([]);
    },
  );

  it("treats a missing probe entry as dir-gone (dirty null / ahead null) → discard", () => {
    const item = makeItem({ state: "plan-gate" }); // has a worktree
    const r = resolveBaseChangeActions([item], "owner/repo", new Map());
    expect(r.discard).toHaveLength(1);
    expect(r.replan).toEqual([item.id]);
    expect(r.skipped).toEqual([]);
  });
});
