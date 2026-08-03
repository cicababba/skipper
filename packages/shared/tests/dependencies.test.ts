import { describe, it, expect } from "vitest";
import type { LifecycleState, SourceRef, TrackedItem } from "../src";
import {
  dependencyBlockReason,
  dependencyIndex,
  displayDependencyRef,
  pendingDependencies,
  unmetDependencies,
} from "../src";

const ref = (n: number | string, project = "o/r"): SourceRef => ({ project, key: String(n) });

function item(
  n: number | string,
  state: LifecycleState,
  overrides: Partial<TrackedItem> = {},
): TrackedItem {
  return {
    id: `github:${n}`,
    source: "github",
    sourceRef: ref(n),
    codeHost: "github",
    accountId: "acc",
    repo: { owner: "o", name: "r" },
    key: String(n),
    title: `Issue ${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    state,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    transitions: [],
    ...overrides,
  };
}

const keys = (links: { ref: SourceRef }[]): string[] => links.map((l) => l.ref.key);

describe("dependencyIndex", () => {
  it("keys items by source and canonical source ref", () => {
    const index = dependencyIndex([item(1, "coding")]);
    expect(index.get("github:o/r#1")?.id).toBe("github:1");
  });

  it("resolves a ref whose project differs only in case", () => {
    const blocked = item(2, "triage", { blockedBy: [ref(1, "O/R")] });
    const index = dependencyIndex([blocked, item(1, "coding")]);
    expect(keys(unmetDependencies(blocked, index))).toEqual(["1"]);
  });

  it("never matches a same-key ref from another tracker", () => {
    const blocked = item(2, "triage", { blockedBy: [ref(1)] });
    const otherTracker = { ...item(1, "coding"), source: "gitlab" as const };
    expect(unmetDependencies(blocked, dependencyIndex([blocked, otherTracker]))).toEqual([]);
  });
});

describe("pendingDependencies", () => {
  it("returns nothing without blockedBy", () => {
    expect(pendingDependencies(item(2, "triage"), dependencyIndex([]))).toEqual([]);
  });

  it("attaches the tracked item it resolves to", () => {
    const blocked = item(2, "triage", { blockedBy: [ref(1)] });
    const blocker = item(1, "coding");
    const links = pendingDependencies(blocked, dependencyIndex([blocked, blocker]));
    expect(links).toEqual([{ ref: ref(1), item: blocker }]);
  });

  it("drops self-references", () => {
    const blocked = item(2, "triage", { blockedBy: [ref(2)] });
    expect(pendingDependencies(blocked, dependencyIndex([blocked]))).toEqual([]);
  });

  it("drops duplicate refs, keeping the first", () => {
    const blocked = item(2, "triage", { blockedBy: [ref(1), ref(1, "O/R")] });
    const links = pendingDependencies(blocked, dependencyIndex([blocked, item(1, "coding")]));
    expect(links).toHaveLength(1);
    expect(links[0].ref.project).toBe("o/r");
  });

  it("drops merged and closed prerequisites", () => {
    for (const state of ["merged", "closed"] as const) {
      const blocked = item(2, "triage", { blockedBy: [ref(1)] });
      expect(pendingDependencies(blocked, dependencyIndex([blocked, item(1, state)]))).toEqual([]);
    }
  });

  it("keeps an untracked ref with no item attached", () => {
    const blocked = item(2, "triage", { blockedBy: [ref(99)] });
    expect(pendingDependencies(blocked, dependencyIndex([blocked]))).toEqual([{ ref: ref(99) }]);
  });

  it("keeps a waived ref — a waiver suppresses the park, not the fact", () => {
    const blocked = item(2, "triage", { blockedBy: [ref(1)], blockedByWaived: [ref(1)] });
    expect(
      keys(pendingDependencies(blocked, dependencyIndex([blocked, item(1, "coding")]))),
    ).toEqual(["1"]);
  });
});

describe("unmetDependencies", () => {
  it("keeps only tracked, unresolved, unwaived prerequisites", () => {
    const blocked = item(4, "triage", {
      blockedBy: [ref(1), ref(2), ref(3), ref(4), ref(99)],
      blockedByWaived: [ref(2)],
    });
    // 1 blocks; 2 waived; 3 merged; 4 self; 99 untracked.
    const index = dependencyIndex([
      blocked,
      item(1, "coding"),
      item(2, "triage"),
      item(3, "merged"),
    ]);
    expect(keys(unmetDependencies(blocked, index))).toEqual(["1"]);
  });

  it("diverges from pendingDependencies on waived and untracked refs", () => {
    const blocked = item(2, "triage", {
      blockedBy: [ref(1), ref(99)],
      blockedByWaived: [ref(1)],
    });
    const index = dependencyIndex([blocked, item(1, "coding")]);
    expect(keys(pendingDependencies(blocked, index))).toEqual(["1", "99"]);
    expect(unmetDependencies(blocked, index)).toEqual([]);
  });
});

describe("displayDependencyRef", () => {
  it("bares the key inside the item's own project, case-insensitively", () => {
    expect(displayDependencyRef(ref(1, "O/R"), item(2, "triage"))).toBe("#1");
  });

  it("qualifies a cross-project ref", () => {
    expect(displayDependencyRef(ref(4, "O/Other"), item(2, "triage"))).toBe("O/Other#4");
  });

  it("keeps a non-numeric tracker key verbatim", () => {
    expect(displayDependencyRef(ref("ISSUE-3"), item(2, "triage"))).toBe("#ISSUE-3");
  });
});

describe("dependencyBlockReason", () => {
  it("joins the display refs behind the release-matched prefix", () => {
    const blocked = item(2, "triage");
    const reason = dependencyBlockReason(blocked, [{ ref: ref(1) }, { ref: ref(4, "O/Other") }]);
    expect(reason).toBe("blocked by #1, O/Other#4");
    expect(reason.startsWith("blocked by")).toBe(true);
  });
});
