import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolutionRecord } from "@skipper/shared";
import { memoryFileName, writeSolutionRecord } from "./store";
import { applyFetched, applyOffered, bumpFetched, bumpOffered } from "./usage";

// Usage counters (#256) are written by the MCP serve subprocess on the record
// files themselves. Pure apply* + best-effort IO: a counter that cannot be
// persisted is never allowed to surface as an error.

const REPO = { owner: "acme", name: "rocket" };
const NOW = "2026-07-20T00:00:00.000Z";

function makeRecord(itemId: string, overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 1,
    itemId,
    repo: REPO,
    title: "fix oauth token refresh",
    url: "https://example.test/7",
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "skipper-usage-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

const readRecord = async (id: string): Promise<SolutionRecord> =>
  JSON.parse(await readFile(join(memoryDir, memoryFileName(id)), "utf-8")) as SolutionRecord;

describe("applyOffered / applyFetched", () => {
  it("starts an absent counter at 1 and stamps the timestamp", () => {
    expect(applyOffered(makeRecord("github:1"), NOW)).toMatchObject({
      offeredCount: 1,
      lastOfferedAt: NOW,
    });
    expect(applyFetched(makeRecord("github:1"), NOW)).toMatchObject({
      fetchedCount: 1,
      lastFetchedAt: NOW,
    });
  });

  it("increments an existing counter and moves the timestamp", () => {
    const rec = makeRecord("github:1", { offeredCount: 4, lastOfferedAt: "2026-01-01T00:00:00.000Z" });
    expect(applyOffered(rec, NOW)).toMatchObject({ offeredCount: 5, lastOfferedAt: NOW });
  });

  it("keeps the two counters independent", () => {
    const offered = applyOffered(makeRecord("github:1"), NOW);
    const both = applyFetched(offered, NOW);
    expect(both.offeredCount).toBe(1);
    expect(both.fetchedCount).toBe(1);
  });

  it("never mutates the record it is given", () => {
    const rec = makeRecord("github:1");
    applyOffered(rec, NOW);
    applyFetched(rec, NOW);
    expect(rec.offeredCount).toBeUndefined();
    expect(rec.fetchedCount).toBeUndefined();
  });
});

describe("bumpOffered", () => {
  it("bumps every ref it is handed and leaves the rest alone", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await writeSolutionRecord(memoryDir, makeRecord("github:2"));
    await writeSolutionRecord(memoryDir, makeRecord("github:3"));

    await bumpOffered(memoryDir, [memoryFileName("github:1"), memoryFileName("github:2")]);

    expect((await readRecord("github:1")).offeredCount).toBe(1);
    expect((await readRecord("github:2")).offeredCount).toBe(1);
    expect((await readRecord("github:3")).offeredCount).toBeUndefined();
  });

  it("accumulates across calls", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await bumpOffered(memoryDir, [memoryFileName("github:1")]);
    await bumpOffered(memoryDir, [memoryFileName("github:1")]);
    expect((await readRecord("github:1")).offeredCount).toBe(2);
  });

  it("upgrades the record it touches to v2", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await writeFile(
      join(memoryDir, memoryFileName("github:1")),
      JSON.stringify({ ...makeRecord("github:1"), version: 1 }),
      "utf-8",
    );
    await bumpOffered(memoryDir, [memoryFileName("github:1")]);
    expect((await readRecord("github:1")).version).toBe(2);
  });

  it("survives a missing record file", async () => {
    await expect(bumpOffered(memoryDir, ["nope.json"])).resolves.toBeUndefined();
  });

  it("survives an unwritable memory dir", async () => {
    const notADir = join(memoryDir, "file.txt");
    await writeFile(notADir, "not a directory", "utf-8");
    await expect(bumpOffered(join(notADir, "memory"), ["x.json"])).resolves.toBeUndefined();
  });

  it("is a no-op for an empty ref list", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await bumpOffered(memoryDir, []);
    expect((await readRecord("github:1")).offeredCount).toBeUndefined();
  });
});

describe("bumpFetched", () => {
  it("stamps the strong signal on one record", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await bumpFetched(memoryDir, memoryFileName("github:1"));

    const rec = await readRecord("github:1");
    expect(rec.fetchedCount).toBe(1);
    expect(Date.parse(rec.lastFetchedAt!)).not.toBeNaN();
    expect(rec.offeredCount).toBeUndefined();
  });

  it("survives a missing record file", async () => {
    await expect(bumpFetched(memoryDir, "nope.json")).resolves.toBeUndefined();
  });
});
