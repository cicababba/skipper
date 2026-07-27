import { describe, expect, it } from "vitest";
import type { MemoryHit, SolutionRecord, StoredPlan } from "@skipper/shared";
import {
  chronological,
  fileOptions,
  filterHitsByFile,
  filterRecordsByFile,
  recordFiles,
} from "./memory-filters";

const REPO = { owner: "acme", name: "rocket" };

function planWith(files: string[]): StoredPlan {
  return {
    version: 2,
    itemId: "github:1",
    repo: REPO,
    generatedAt: "2026-07-01T00:00:00.000Z",
    model: "test",
    plan: {
      summary: "s",
      files: files.map((path) => ({ path, reason: "touched" })),
      steps: [],
      acceptance: [],
      risks: [],
      openQuestions: [],
      estimatedSize: "s",
    },
  };
}

function record(itemId: string, overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 1,
    itemId,
    repo: REPO,
    title: itemId,
    url: "https://example.test",
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function hit(id: string, filesTouched: string[]): MemoryHit {
  return {
    id,
    ref: `${id}.json`,
    score: 1,
    title: id,
    issueKey: "",
    url: "",
    filesTouched,
    capturedAt: "2026-07-10T00:00:00.000Z",
  };
}

describe("chronological", () => {
  it("orders newest capture first", () => {
    const list = [
      record("a", { capturedAt: "2026-01-01T00:00:00.000Z" }),
      record("b", { capturedAt: "2026-07-01T00:00:00.000Z" }),
      record("c", { capturedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(chronological(list).map((r) => r.itemId)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input", () => {
    const list = [
      record("a", { capturedAt: "2026-01-01T00:00:00.000Z" }),
      record("b", { capturedAt: "2026-07-01T00:00:00.000Z" }),
    ];
    chronological(list);
    expect(list.map((r) => r.itemId)).toEqual(["a", "b"]);
  });

  it("handles an empty list", () => {
    expect(chronological([])).toEqual([]);
  });
});

describe("recordFiles", () => {
  it("prefers the captured diff stats", () => {
    const rec = record("a", {
      diffStats: { filesChanged: 1, totalChangedLines: 2, files: ["src/diff.ts"] },
      plan: planWith(["src/plan.ts"]),
      note: { body: "b", files: ["src/note.ts"] },
    });
    expect(recordFiles(rec)).toEqual(["src/diff.ts"]);
  });

  it("falls back to the plan's files", () => {
    expect(recordFiles(record("a", { plan: planWith(["src/plan.ts"]) }))).toEqual(["src/plan.ts"]);
  });

  it("falls back to the note's files", () => {
    expect(recordFiles(record("a", { kind: "note", note: { body: "b", files: ["src/n.ts"] } }))).toEqual(
      ["src/n.ts"],
    );
  });

  it("returns [] for a note with no links and for a bare record", () => {
    expect(recordFiles(record("a", { kind: "note", note: { body: "b" } }))).toEqual([]);
    expect(recordFiles(record("a"))).toEqual([]);
  });

  it("treats an empty diffStats file list as the answer, not a miss", () => {
    const rec = record("a", {
      diffStats: { filesChanged: 0, totalChangedLines: 0, files: [] },
      plan: planWith(["src/plan.ts"]),
    });
    expect(recordFiles(rec)).toEqual([]);
  });
});

describe("fileOptions", () => {
  it("unions, deduplicates and sorts across sources", () => {
    const list = [
      record("a", {
        diffStats: { filesChanged: 1, totalChangedLines: 1, files: ["src/z.ts", "src/a.ts"] },
      }),
      record("b", { plan: planWith(["src/a.ts", "src/m.ts"]) }),
      record("c", { kind: "note", note: { body: "b", files: ["src/b.ts"] } }),
    ];
    expect(fileOptions(list)).toEqual(["src/a.ts", "src/b.ts", "src/m.ts", "src/z.ts"]);
  });

  it("returns [] when nothing touches a file", () => {
    expect(fileOptions([record("a")])).toEqual([]);
    expect(fileOptions([])).toEqual([]);
  });
});

describe("filterRecordsByFile", () => {
  const list = [
    record("a", { plan: planWith(["src/a.ts"]) }),
    record("b", { plan: planWith(["src/b.ts"]) }),
    record("c", { kind: "note", note: { body: "n", files: ["src/a.ts"] } }),
  ];

  it("passes everything through for a null filter", () => {
    expect(filterRecordsByFile(list, null)).toHaveLength(3);
  });

  it("keeps only records touching the file, notes included", () => {
    expect(filterRecordsByFile(list, "src/a.ts").map((r) => r.itemId)).toEqual(["a", "c"]);
  });

  it("matches exactly — no prefix or substring matching", () => {
    expect(filterRecordsByFile(list, "src/a")).toEqual([]);
  });
});

describe("filterHitsByFile", () => {
  const hits = [hit("a", ["src/a.ts"]), hit("b", ["src/b.ts", "src/a.ts"]), hit("c", [])];

  it("passes everything through for a null filter", () => {
    expect(filterHitsByFile(hits, null)).toHaveLength(3);
  });

  it("keeps only hits touching the file", () => {
    expect(filterHitsByFile(hits, "src/a.ts").map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("drops hits with no files when a filter is set", () => {
    expect(filterHitsByFile(hits, "src/b.ts").map((h) => h.id)).toEqual(["b"]);
  });
});
