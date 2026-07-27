import { describe, expect, it } from "vitest";
import type { MemoryHit, SolutionRecord, StoredPlan } from "@skipper/shared";
import {
  basename,
  buildMemoryGraph,
  dimmedNodeIds,
  egoIds,
  fileRadius,
  sentimentOf,
  showFileLabel,
} from "./memory-graph";

const REPO = { owner: "acme", name: "rocket" };

function planWith(files: string[]): StoredPlan {
  return {
    version: 2,
    itemId: "x",
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

function record(itemId: string, files: string[], overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 1,
    itemId,
    repo: REPO,
    title: `title ${itemId}`,
    url: "https://example.test",
    plan: planWith(files),
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

const hit = (id: string): MemoryHit => ({
  id,
  ref: `${id}.json`,
  score: 1,
  title: id,
  issueKey: "",
  url: "",
  filesTouched: [],
  capturedAt: "2026-07-10T00:00:00.000Z",
});

describe("basename", () => {
  it("takes the last segment", () => {
    expect(basename("src/auth/oauth.ts")).toBe("oauth.ts");
  });

  it("passes through a bare filename", () => {
    expect(basename("README.md")).toBe("README.md");
  });
});

describe("sentimentOf", () => {
  it("buckets by net feedback", () => {
    expect(sentimentOf({ up: 3, down: 1 })).toBe("positive");
    expect(sentimentOf({ up: 1, down: 3 })).toBe("negative");
    expect(sentimentOf({ up: 2, down: 2 })).toBe("neutral");
  });

  it("treats absent or empty feedback as neutral", () => {
    expect(sentimentOf(undefined)).toBe("neutral");
    expect(sentimentOf({ up: 0, down: 0 })).toBe("neutral");
  });
});

describe("buildMemoryGraph — nodes", () => {
  it("emits one node per record, notes flagged distinctly", () => {
    const graph = buildMemoryGraph([
      record("github:1", []),
      record("note:a", [], { kind: "note", note: { body: "b" } }),
    ]);
    expect(graph.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["github:1", "memory"],
      ["note:a", "note"],
    ]);
  });

  it("carries the title and the sentiment bucket onto memory nodes", () => {
    const graph = buildMemoryGraph([record("github:1", [], { feedback: { up: 2, down: 0 } })]);
    expect(graph.nodes[0]).toMatchObject({
      label: "title github:1",
      sentiment: "positive",
    });
  });

  it("returns an empty graph for no records", () => {
    expect(buildMemoryGraph([])).toEqual({ nodes: [], links: [] });
  });
});

describe("buildMemoryGraph — file threshold", () => {
  it("drops a file touched by a single memory", () => {
    const graph = buildMemoryGraph([record("github:1", ["src/only.ts"])]);
    expect(graph.nodes.filter((n) => n.kind === "file")).toEqual([]);
    expect(graph.links).toEqual([]);
  });

  it("keeps a file shared by two memories and links both", () => {
    const graph = buildMemoryGraph([
      record("github:1", ["src/shared.ts", "src/only-a.ts"]),
      record("github:2", ["src/shared.ts"]),
    ]);
    const files = graph.nodes.filter((n) => n.kind === "file");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: "file:src/shared.ts", label: "shared.ts", degree: 2 });
    expect(graph.links).toEqual([
      { source: "github:1", target: "file:src/shared.ts" },
      { source: "github:2", target: "file:src/shared.ts" },
    ]);
  });

  it("counts a file once per record even if the record lists it twice", () => {
    const graph = buildMemoryGraph([
      record("github:1", ["src/dup.ts", "src/dup.ts"]),
      record("github:2", ["src/other.ts"]),
    ]);
    expect(graph.nodes.filter((n) => n.kind === "file")).toEqual([]);
  });

  it("links notes to shared files too", () => {
    const graph = buildMemoryGraph([
      record("github:1", ["src/shared.ts"]),
      record("note:a", [], {
        kind: "note",
        note: { body: "b", files: ["src/shared.ts"] },
        plan: undefined,
      }),
    ]);
    expect(graph.links.map((l) => l.source).sort()).toEqual(["github:1", "note:a"]);
  });

  it("orders file nodes by path for a stable layout", () => {
    const graph = buildMemoryGraph([
      record("github:1", ["src/z.ts", "src/a.ts"]),
      record("github:2", ["src/z.ts", "src/a.ts"]),
    ]);
    expect(graph.nodes.filter((n) => n.kind === "file").map((n) => n.id)).toEqual([
      "file:src/a.ts",
      "file:src/z.ts",
    ]);
  });
});

describe("fileRadius", () => {
  it("grows with the degree", () => {
    expect(fileRadius(4)).toBeGreaterThan(fileRadius(2));
    expect(fileRadius(9)).toBeGreaterThan(fileRadius(4));
  });

  it("grows sublinearly", () => {
    expect(fileRadius(9) - fileRadius(8)).toBeLessThan(fileRadius(3) - fileRadius(2));
  });

  it("caps at 10", () => {
    expect(fileRadius(1000)).toBe(10);
  });
});

describe("showFileLabel", () => {
  it("labels hub files at any zoom", () => {
    expect(showFileLabel(4, 0.5, false, false)).toBe(true);
  });

  it("hides tail files when zoomed out", () => {
    expect(showFileLabel(3, 1, false, false)).toBe(false);
    expect(showFileLabel(2, 0.4, false, false)).toBe(false);
  });

  it("labels everything once zoomed in", () => {
    expect(showFileLabel(2, 1.5, false, false)).toBe(true);
  });

  it("labels the hovered and the active file whatever the zoom", () => {
    expect(showFileLabel(2, 0.3, true, false)).toBe(true);
    expect(showFileLabel(2, 0.3, false, true)).toBe(true);
  });
});

describe("egoIds", () => {
  const graph = buildMemoryGraph([
    record("github:1", ["src/shared.ts"]),
    record("github:2", ["src/shared.ts", "src/other.ts"]),
    record("github:3", ["src/other.ts"]),
  ]);

  it("collects a memory node and the files it touches", () => {
    expect([...egoIds(graph, "github:2")].sort()).toEqual([
      "file:src/other.ts",
      "file:src/shared.ts",
      "github:2",
    ]);
  });

  it("collects a file node and the memories touching it", () => {
    expect([...egoIds(graph, "file:src/shared.ts")].sort()).toEqual([
      "file:src/shared.ts",
      "github:1",
      "github:2",
    ]);
  });

  it("returns just the node itself when it has no links", () => {
    expect([...egoIds(graph, "nope")]).toEqual(["nope"]);
  });
});

describe("dimmedNodeIds", () => {
  const graph = buildMemoryGraph([
    record("github:1", ["src/shared.ts"]),
    record("github:2", ["src/shared.ts"]),
    record("github:3", ["src/other.ts"]),
  ]);

  it("dims nothing without a search or a filter", () => {
    expect(dimmedNodeIds(graph, null, null).size).toBe(0);
  });

  it("dims memories outside the search hits, leaving files alone", () => {
    const dimmed = dimmedNodeIds(graph, [hit("github:1")], null);
    expect([...dimmed]).toEqual(["github:2", "github:3"]);
  });

  it("dims memories not on the filtered file, and the other file nodes", () => {
    const dimmed = dimmedNodeIds(graph, null, "src/shared.ts");
    expect(dimmed.has("github:3")).toBe(true);
    expect(dimmed.has("github:1")).toBe(false);
    expect(dimmed.has("github:2")).toBe(false);
    expect(dimmed.has("file:src/shared.ts")).toBe(false);
  });

  it("intersects a search and a file filter", () => {
    const dimmed = dimmedNodeIds(graph, [hit("github:1")], "src/shared.ts");
    expect(dimmed.has("github:1")).toBe(false);
    expect(dimmed.has("github:2")).toBe(true);
    expect(dimmed.has("github:3")).toBe(true);
  });

  it("dims every memory when the search matched none of them", () => {
    const dimmed = dimmedNodeIds(graph, [], null);
    expect(dimmed.has("github:1")).toBe(true);
    expect(dimmed.has("github:2")).toBe(true);
    expect(dimmed.has("github:3")).toBe(true);
  });

  it("dims a memory filtered on a file that is not in the graph", () => {
    const dimmed = dimmedNodeIds(graph, null, "src/only.ts");
    expect(dimmed.has("github:1")).toBe(true);
    expect(dimmed.has("github:3")).toBe(true);
  });
});
