import { describe, expect, it } from "vitest";
import type { TrackedItem } from "@skipper/shared";
import { filterItems, formatAge, sortItems } from "./table";

function item(overrides: Partial<TrackedItem>): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "octo/repo", key: "1" },
    codeHost: "github",
    key: "1",
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

describe("sortItems", () => {
  const items = [
    item({ id: "a", plan: { confidence: 0.9 }, createdAt: "2026-07-03T00:00:00Z" }),
    item({ id: "b", plan: { confidence: 0.2 }, createdAt: "2026-07-01T00:00:00Z" }),
    item({ id: "c", createdAt: "2026-07-02T00:00:00Z" }),
  ];

  it("sorts by confidence with unscored last in both directions", () => {
    expect(sortItems(items, "confidence", "desc").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(sortItems(items, "confidence", "asc").map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by age", () => {
    expect(sortItems(items, "age", "desc").map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(sortItems(items, "age", "asc").map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by repo key", () => {
    const mixed = [
      item({ id: "z", repo: { owner: "zeta", name: "z" } }),
      item({ id: "a", repo: { owner: "alpha", name: "a" } }),
    ];
    expect(sortItems(mixed, "repo", "asc").map((i) => i.id)).toEqual(["a", "z"]);
    expect(sortItems(mixed, "repo", "desc").map((i) => i.id)).toEqual(["z", "a"]);
  });

  it("sorts by state in lifecycle column order", () => {
    const mixed = [
      item({ id: "done", state: "merged" }),
      item({ id: "stuck", state: "failed" }),
      item({ id: "active", state: "coding" }),
    ];
    expect(sortItems(mixed, "state", "asc").map((i) => i.id)).toEqual(["stuck", "active", "done"]);
  });

  it("does not mutate the input", () => {
    const input = [...items];
    sortItems(input, "confidence", "asc");
    expect(input.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("filterItems", () => {
  const items = [
    item({ id: "a", plan: { confidence: 0.9 }, state: "plan-gate" }),
    item({ id: "b", plan: { confidence: 0.3 }, repo: { owner: "alpha", name: "a" } }),
    item({ id: "c", state: "failed" }),
  ];

  it("filters by repo key", () => {
    expect(filterItems(items, { repo: "alpha/a" }).map((i) => i.id)).toEqual(["b"]);
  });

  it("filters by column set including attention", () => {
    expect(
      filterItems(items, { columns: new Set(["attention"]) }).map((i) => i.id),
    ).toEqual(["c"]);
    expect(
      filterItems(items, { columns: new Set(["planGate", "triage"]) }).map((i) => i.id),
    ).toEqual(["a", "b"]);
  });

  it("empty column set means no column filter", () => {
    expect(filterItems(items, { columns: new Set() })).toHaveLength(3);
  });

  it("min confidence excludes unscored items", () => {
    expect(filterItems(items, { minConfidence: 0.5 }).map((i) => i.id)).toEqual(["a"]);
  });

  it("combines filters", () => {
    expect(
      filterItems(items, { repo: "octo/repo", columns: new Set(["planGate"]) }).map((i) => i.id),
    ).toEqual(["a"]);
  });
});

describe("formatAge", () => {
  const now = new Date("2026-07-10T12:00:00Z");

  it("minutes under an hour", () => {
    expect(formatAge("2026-07-10T11:59:00Z", now)).toEqual({ value: 1, unit: "m" });
    expect(formatAge("2026-07-10T11:00:01Z", now)).toEqual({ value: 59, unit: "m" });
  });

  it("hours under a day", () => {
    expect(formatAge("2026-07-10T11:00:00Z", now)).toEqual({ value: 1, unit: "h" });
    expect(formatAge("2026-07-09T12:00:01Z", now)).toEqual({ value: 23, unit: "h" });
  });

  it("days from 24h up", () => {
    expect(formatAge("2026-07-09T12:00:00Z", now)).toEqual({ value: 1, unit: "d" });
    expect(formatAge("2026-07-01T00:00:00Z", now)).toEqual({ value: 9, unit: "d" });
  });

  it("clamps future timestamps to zero", () => {
    expect(formatAge("2026-07-10T12:05:00Z", now)).toEqual({ value: 0, unit: "m" });
  });
});
