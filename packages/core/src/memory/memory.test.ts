import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolutionRecord, StoredPlan } from "@skipper/shared";
import { registerTransformersLoader } from "../vectorstore/embedder";
import {
  listSolutionRecords,
  memoryFileName,
  readSolutionRecord,
  writeSolutionRecord,
} from "./store";
import { buildEmbedText, indexOneRecord, reconcileMemoryIndex } from "./indexer";
import { createNoteRecord } from "./notes";
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

// The single trap of #256: a gate that stopped accepting v1 would make every
// pre-existing record vanish from list/search/serve at once.
describe("store — the v2 version gate (#256)", () => {
  const writeRaw = async (name: string, body: unknown) =>
    writeFile(join(memoryDir, name), JSON.stringify(body), "utf-8");

  it("reads both v1 and v2 files", async () => {
    await writeRaw("v1.json", { ...makeRecord("github:1"), version: 1 });
    await writeRaw("v2.json", { ...makeRecord("github:2"), version: 2, lesson: "Problem: p" });

    expect((await readSolutionRecord(memoryDir, "v1.json"))?.itemId).toBe("github:1");
    expect((await readSolutionRecord(memoryDir, "v2.json"))?.lesson).toBe("Problem: p");
    expect((await listSolutionRecords(memoryDir)).map((e) => e.record.itemId).sort()).toEqual([
      "github:1",
      "github:2",
    ]);
  });

  it("rejects a version it does not know", async () => {
    await writeRaw("v3.json", { ...makeRecord("github:3"), version: 3 });
    expect(await readSolutionRecord(memoryDir, "v3.json")).toBeNull();
    expect(await listSolutionRecords(memoryDir)).toEqual([]);
  });

  it("normalizes every write to v2, whatever the record said", async () => {
    const ref = await writeSolutionRecord(memoryDir, makeRecord("github:1", { version: 1 }));
    expect((await readSolutionRecord(memoryDir, ref))?.version).toBe(2);
    expect(JSON.parse(await readFile(join(memoryDir, ref), "utf-8")).version).toBe(2);
  });

  it("upgrades a v1 file in place the first time it is touched", async () => {
    await writeRaw(memoryFileName("github:1"), { ...makeRecord("github:1"), version: 1 });
    const record = (await readSolutionRecord(memoryDir, memoryFileName("github:1")))!;
    record.feedback = { up: 1, down: 0 };
    await writeSolutionRecord(memoryDir, record);
    expect((await readSolutionRecord(memoryDir, memoryFileName("github:1")))?.version).toBe(2);
  });
});

describe("buildEmbedText — the distilled lesson (#256)", () => {
  it("embeds the lesson after the plan gist and before the files", () => {
    const text = buildEmbedText(
      makeRecord("github:1", { lesson: "Problem: token clock\nInsight: invert it" }),
    );
    expect(text).toContain("Problem: token clock");
    expect(text.indexOf("fix oauth token refresh")).toBeLessThan(text.indexOf("Problem: token clock"));
    expect(text.indexOf("Problem: token clock")).toBeLessThan(text.indexOf("src/auth/oauth.ts"));
  });

  it("leaves a lesson-less record's text exactly as it was", () => {
    expect(buildEmbedText(makeRecord("github:1"))).not.toContain("Problem:");
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

  it("carries the distilled lesson onto the hit (#256)", async () => {
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:1", { lesson: "Problem: p\nInsight: i" }),
    );
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A });
    expect(hits[0]?.lesson).toBe("Problem: p\nInsight: i");
  });

  it("leaves lesson undefined on a record that has none", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A });
    expect(hits[0]?.lesson).toBeUndefined();
  });

  // #256: files gone at the base ref weigh a memory down at query time — no
  // reindex involved, exactly like feedback.
  it("staleness demotes an otherwise identical record", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", { staleness: 1 }));
    await writeSolutionRecord(memoryDir, makeRecord("github:2"));
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A });
    expect(hits.map((h) => h.id)).toEqual(["github:2", "github:1"]);
    expect(hits[1].score).toBeCloseTo(hits[0].score * 0.5, 10);
  });

  it("leaves the score untouched for a never-measured record", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", { staleness: 0 }));
    await writeSolutionRecord(memoryDir, makeRecord("github:2"));
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A });
    expect(hits[0].score).toBeCloseTo(hits[1].score, 10);
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

describe("notes in the corpus (#255)", () => {
  it("retrieves a note by terms that appear only in its body", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await writeSolutionRecord(
      memoryDir,
      createNoteRecord(REPO_A, "the windows pty resize race needs a debounce"),
    );
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "windows pty resize debounce", { repo: REPO_A });
    expect(hits[0]?.kind).toBe("note");
  });

  it("shapes a note hit with no pr, an empty issueKey and the note's files", async () => {
    const note = createNoteRecord(REPO_A, "prefer structured logging", ["src/log.ts"]);
    await writeSolutionRecord(memoryDir, note);
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "prefer structured logging", { repo: REPO_A });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: note.itemId,
      kind: "note",
      issueKey: "",
      filesTouched: ["src/log.ts"],
    });
    expect(hits[0].pr).toBeUndefined();
    expect(hits[0].planSummary).toBeUndefined();
  });

  it("keeps notes scoped to their repo", async () => {
    await writeSolutionRecord(memoryDir, createNoteRecord(REPO_B, "anvil only wisdom"));
    await reconcileMemoryIndex(memoryDir);

    expect(await searchMemory(memoryDir, "anvil only wisdom", { repo: REPO_A })).toEqual([]);
    expect(
      (await searchMemory(memoryDir, "anvil only wisdom", { repo: REPO_B })).map((h) => h.kind),
    ).toEqual(["note"]);
  });

  it("reconcile indexes an unindexed note alongside solutions", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await reconcileMemoryIndex(memoryDir);

    await writeSolutionRecord(memoryDir, createNoteRecord(REPO_A, "a late arriving note"));
    expect(await reconcileMemoryIndex(memoryDir)).toEqual({ indexed: 1, removed: 0, total: 2 });
  });

  it("gives a solution hit an empty issueKey rather than the string \"undefined\"", async () => {
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:1", { issueKey: undefined, issueNumber: undefined }),
    );
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "fix oauth token refresh", { repo: REPO_A });
    expect(hits[0]?.issueKey).toBe("");
  });
});

describe("indexOneRecord (#255)", () => {
  it("makes a single record searchable without a full reconcile", async () => {
    const note = createNoteRecord(REPO_A, "inline indexed straight away");
    const ref = await writeSolutionRecord(memoryDir, note);
    await indexOneRecord(memoryDir, ref, note);

    const hits = await searchMemory(memoryDir, "inline indexed straight away", { repo: REPO_A });
    expect(hits.map((h) => h.id)).toEqual([note.itemId]);
  });

  it("re-upserts an edited note so the new wording is findable", async () => {
    const note = createNoteRecord(REPO_A, "original wording about caching");
    const ref = await writeSolutionRecord(memoryDir, note);
    await indexOneRecord(memoryDir, ref, note);

    note.note = { body: "rewritten wording about throttling" };
    await writeSolutionRecord(memoryDir, note);
    await indexOneRecord(memoryDir, ref, note);

    const hits = await searchMemory(memoryDir, "rewritten wording about throttling", {
      repo: REPO_A,
    });
    expect(hits.map((h) => h.id)).toEqual([note.itemId]);
    // Re-upsert replaces rather than duplicates the entry.
    expect(await reconcileMemoryIndex(memoryDir)).toEqual({ indexed: 0, removed: 0, total: 1 });
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
