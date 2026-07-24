import { describe, expect, it } from "vitest";
import type { LifecycleState, SourceRef, TrackedItem } from "@skipper/shared";
import { blockingItemsFor } from "./blocked";

function item(n: number, state: LifecycleState, overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: `github:${n}`,
    source: "github",
    sourceRef: { project: "o/r", key: String(n) },
    codeHost: "github",
    accountId: "acc",
    repo: { owner: "o", name: "r" },
    key: String(n),
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    state,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    transitions: [],
    ...overrides,
  };
}

const ref = (n: number, project = "o/r"): SourceRef => ({ project, key: String(n) });

describe("blockingItemsFor", () => {
  it("resolves tracked, unresolved prerequisites", () => {
    const blocked = item(2, "blocked", { blockedBy: [ref(1)] });
    const blocker = item(1, "coding");
    expect(blockingItemsFor(blocked, [blocked, blocker])).toEqual([blocker]);
  });

  it("returns nothing without blockedBy", () => {
    expect(blockingItemsFor(item(2, "blocked"), [])).toEqual([]);
  });

  it("ignores merged/closed prerequisites", () => {
    const blocked = item(2, "blocked", { blockedBy: [ref(1)] });
    expect(blockingItemsFor(blocked, [blocked, item(1, "merged")])).toEqual([]);
    expect(blockingItemsFor(blocked, [blocked, item(1, "closed")])).toEqual([]);
  });

  it("ignores untracked, self, and waived refs", () => {
    const blocked = item(2, "blocked", {
      blockedBy: [ref(1), ref(2), ref(3)],
      blockedByWaived: [ref(3)],
    });
    // 1 untracked, 2 self, 3 waived → nothing resolves.
    expect(blockingItemsFor(blocked, [blocked, item(3, "triage")])).toEqual([]);
  });

  it("resolves case-insensitively", () => {
    const blocked = item(2, "blocked", { blockedBy: [ref(1, "O/R")] });
    const blocker = item(1, "coding");
    expect(blockingItemsFor(blocked, [blocked, blocker])).toEqual([blocker]);
  });
});
