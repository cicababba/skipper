import { describe, expect, it } from "vitest";
import type { LifecycleState, TrackedItem } from "@nestbrain/shared";
import { TRANSITIONS } from "@nestbrain/shared";
import {
  ATTENTION_SECTION_STATES,
  ATTENTION_STATES,
  attentionCounts,
  columnFor,
  KANBAN_COLUMNS,
  repoKey,
  reposOf,
} from "./model";

const ALL_STATES = Object.keys(TRANSITIONS) as LifecycleState[];

function item(overrides: Partial<TrackedItem>): TrackedItem {
  return {
    id: "github:1",
    platform: "github",
    accountId: "acc",
    repo: { owner: "octo", name: "repo" },
    number: 1,
    title: "t",
    url: "https://github.com/octo/repo/issues/1",
    state: "triage",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    transitions: [],
    ...overrides,
  };
}

describe("columnFor", () => {
  it("maps every lifecycle state to exactly one column or the attention section", () => {
    for (const state of ALL_STATES) {
      const column = columnFor(state);
      if (column === "attention") {
        expect(ATTENTION_SECTION_STATES).toContain(state);
        expect(KANBAN_COLUMNS.some((c) => c.states.includes(state))).toBe(false);
      } else {
        const owners = KANBAN_COLUMNS.filter((c) => c.states.includes(state));
        expect(owners.map((c) => c.id)).toEqual([column]);
        expect(ATTENTION_SECTION_STATES).not.toContain(state);
      }
    }
  });

  it("covers all 15 states between columns and attention", () => {
    const mapped = new Set([
      ...KANBAN_COLUMNS.flatMap((c) => c.states),
      ...ATTENTION_SECTION_STATES,
    ]);
    expect([...mapped].sort()).toEqual([...ALL_STATES].sort());
    expect(ALL_STATES).toHaveLength(15);
  });
});

describe("attentionCounts", () => {
  it("counts only waits-for-you states, grouped by repo", () => {
    const items = [
      item({ id: "1", state: "plan-gate" }),
      item({ id: "2", state: "coding" }),
      item({ id: "3", state: "failed", repo: { owner: "octo", name: "other" } }),
      item({ id: "4", state: "human-review" }),
      item({ id: "5", state: "merged" }),
    ];
    const { total, byRepo } = attentionCounts(items);
    expect(total).toBe(3);
    expect(byRepo.get("octo/repo")).toBe(2);
    expect(byRepo.get("octo/other")).toBe(1);
  });

  it("badge states match the agreed set", () => {
    expect([...ATTENTION_STATES].sort()).toEqual(
      ["blocked", "failed", "human-review", "needs-input", "plan-gate"].sort(),
    );
  });
});

describe("reposOf", () => {
  it("dedupes and sorts by key", () => {
    const items = [
      item({ id: "1", repo: { owner: "zeta", name: "z" } }),
      item({ id: "2", repo: { owner: "alpha", name: "a" } }),
      item({ id: "3", repo: { owner: "zeta", name: "z" } }),
    ];
    expect(reposOf(items).map(repoKey)).toEqual(["alpha/a", "zeta/z"]);
  });
});
