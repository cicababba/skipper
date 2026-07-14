import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolutionRecord, StoredPlan } from "@skipper/shared";
import { registerTransformersLoader } from "../vectorstore/embedder";
import { listSolutionRecords, memoryFileName, writeSolutionRecord } from "./store";
import { reconcileMemoryIndex } from "./indexer";
import { searchMemory } from "./search";
import { feedbackWeight, recencyWeight } from "./ranking";

// Deterministic bag-of-words embedder: identical texts → identical vectors,
// shared words → positive cosine. No model download in tests.
function vecFor(text: string): number[] {
  const v = new Array(32).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    v[h % 32] += 1;
  }
  const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0)) || 1;
  return v.map((x: number) => x / norm);
}

beforeAll(() => {
  registerTransformersLoader(() => ({
    pipeline: async () =>
      async (text: string) => ({ tolist: () => [vecFor(text)] }),
  }));
});

const REPO_A = { owner: "acme", name: "rocket" };
const REPO_B = { owner: "acme", name: "anvil" };

function makePlan(itemId: string, summary: string): StoredPlan {
  return {
    version: 2,
    itemId,
    repo: REPO_A,
    issueNumber: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    model: "test",
    plan: {
      summary,
      files: [{ path: "src/auth/oauth.ts", reason: "touched" }],
      steps: [{ title: summary, detail: "", files: [], symbols: [] }],
      acceptance: [],
      risks: [],
      openQuestions: [],
      estimatedSize: "s",
    },
  };
}

function makeRecord(
  itemId: string,
  overrides: Partial<SolutionRecord> & { summary?: string } = {},
): SolutionRecord {
  const { summary, ...rest } = overrides;
  return {
    version: 1,
    itemId,
    repo: REPO_A,
    issueNumber: 7,
    title: summary ?? "fix oauth token refresh",
    url: "https://github.com/acme/rocket/issues/7",
    pr: { number: 8, url: "https://github.com/acme/rocket/pull/8" },
    plan: makePlan(itemId, summary ?? "fix oauth token refresh"),
    diffStats: { filesChanged: 1, totalChangedLines: 10, files: ["src/auth/oauth.ts"] },
    outcome: "merged",
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...rest,
  };
}

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "skipper-memory-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

describe("store", () => {
  it("round-trips write → list", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await writeSolutionRecord(memoryDir, makeRecord("github:2"));
    const entries = await listSolutionRecords(memoryDir);
    expect(entries.map((e) => e.record.itemId).sort()).toEqual(["github:1", "github:2"]);
    expect(entries.map((e) => e.ref).sort()).toEqual(["github_1.json", "github_2.json"]);
  });

  it("skips foreign and invalid json files", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await writeFile(join(memoryDir, "vector-index.json"), JSON.stringify({ entries: [] }));
    await writeFile(join(memoryDir, "garbage.json"), "not json at all");
    await writeFile(join(memoryDir, "notes.txt"), "ignored");
    const entries = await listSolutionRecords(memoryDir);
    expect(entries).toHaveLength(1);
  });

  it("returns [] for a missing directory", async () => {
    expect(await listSolutionRecords(join(memoryDir, "nope"))).toEqual([]);
  });
});

describe("reconcileMemoryIndex", () => {
  it("indexes missing records, is idempotent, removes stale entries", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await writeSolutionRecord(memoryDir, makeRecord("github:2"));

    const first = await reconcileMemoryIndex(memoryDir);
    expect(first).toEqual({ indexed: 2, removed: 0, total: 2 });

    const second = await reconcileMemoryIndex(memoryDir);
    expect(second).toEqual({ indexed: 0, removed: 0, total: 2 });

    await unlink(join(memoryDir, memoryFileName("github:2")));
    const third = await reconcileMemoryIndex(memoryDir);
    expect(third).toEqual({ indexed: 0, removed: 1, total: 1 });
  });
});

describe("searchMemory", () => {
  it("returns [] on empty memory", async () => {
    const hits = await searchMemory(memoryDir, "anything", { repo: REPO_A });
    expect(hits).toEqual([]);
  });

  it("scopes to the requested repo", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", { repo: REPO_A }));
    await writeSolutionRecord(memoryDir, makeRecord("github:2", { repo: REPO_B }));
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A });
    expect(hits.map((h) => h.id)).toEqual(["github:1"]);
  });

  it("ranks the semantically closer record first", async () => {
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:1", { summary: "fix oauth token refresh flow" }),
    );
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:2", { summary: "terminal resize race on windows pty" }),
    );
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "oauth refresh broken", { repo: REPO_A });
    expect(hits[0]?.id).toBe("github:1");
  });

  it("feedback flips the order of equally similar records", async () => {
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:1", { feedback: { up: 0, down: 5 } }),
    );
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:2", { feedback: { up: 5, down: 0 } }),
    );
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A });
    expect(hits.map((h) => h.id)).toEqual(["github:2", "github:1"]);
  });

  it("recency orders newer records first for identical content", async () => {
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:1", { capturedAt: "2024-01-01T00:00:00.000Z" }),
    );
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:2", { capturedAt: new Date().toISOString() }),
    );
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A });
    expect(hits.map((h) => h.id)).toEqual(["github:2", "github:1"]);
  });

  it("respects k", async () => {
    for (let i = 0; i < 8; i++) {
      await writeSolutionRecord(memoryDir, makeRecord(`github:${i}`));
    }
    await reconcileMemoryIndex(memoryDir);
    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A, k: 3 });
    expect(hits).toHaveLength(3);
  });
});

describe("ranking", () => {
  it("recencyWeight: fresh ≈ 1, ancient hits the floor, garbage dates hit the floor", () => {
    const now = Date.parse("2026-07-14T00:00:00.000Z");
    expect(recencyWeight("2026-07-14T00:00:00.000Z", now)).toBeCloseTo(1, 5);
    expect(recencyWeight("2026-01-15T00:00:00.000Z", now)).toBeCloseTo(0.5, 2); // ~180d
    expect(recencyWeight("2016-07-14T00:00:00.000Z", now)).toBe(0.3);
    expect(recencyWeight("not-a-date", now)).toBe(0.3);
  });

  it("feedbackWeight: neutral 1, all-up → 2, all-down → 0", () => {
    expect(feedbackWeight(undefined)).toBe(1);
    expect(feedbackWeight({ up: 0, down: 0 })).toBe(1);
    expect(feedbackWeight({ up: 4, down: 0 })).toBeCloseTo(10 / 6, 5);
    expect(feedbackWeight({ up: 0, down: 4 })).toBeCloseTo(2 / 6, 5);
    expect(feedbackWeight({ up: 1000, down: 0 })).toBeGreaterThan(1.99);
    expect(feedbackWeight({ up: 0, down: 1000 })).toBeLessThan(0.01);
  });
});
