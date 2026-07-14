import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolutionRecord } from "@skipper/shared";
import {
  registerTransformersLoader,
  writeSolutionRecord,
  reconcileMemoryIndex,
} from "@skipper/core";
import { runSearchMemory, runGetMemory } from "./memory-serve.js";

// Deterministic bag-of-words embedder — no model download in tests.
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
    pipeline: async () => async (text: string) => ({ tolist: () => [vecFor(text)] }),
  }));
});

const REPO_A = { owner: "acme", name: "rocket" };
const REPO_B = { owner: "acme", name: "anvil" };

function makeRecord(itemId: string, repo: SolutionRecord["repo"]): SolutionRecord {
  return {
    version: 1,
    itemId,
    repo,
    issueNumber: 7,
    title: "fix oauth token refresh",
    url: "https://github.com/acme/rocket/issues/7",
    pr: { number: 8, url: "https://github.com/acme/rocket/pull/8" },
    diffStats: { filesChanged: 1, totalChangedLines: 10, files: ["src/auth/oauth.ts"] },
    outcome: "merged",
    capturedAt: "2026-07-10T00:00:00.000Z",
  };
}

let memoryDir: string;
beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "skipper-serve-"));
});
afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

describe("runSearchMemory", () => {
  it("returns [] on empty memory, never errors", async () => {
    const res = await runSearchMemory({ repo: REPO_A, memoryDir }, { query: "anything" });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual([]);
  });

  it("errors on a blank query", async () => {
    const res = await runSearchMemory({ repo: REPO_A, memoryDir }, { query: "  " });
    expect(res.isError).toBe(true);
  });

  it("only returns the scoped repo's records", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", REPO_A));
    await writeSolutionRecord(memoryDir, makeRecord("github:2", REPO_B));
    await reconcileMemoryIndex(memoryDir);

    const res = await runSearchMemory({ repo: REPO_A, memoryDir }, { query: "fix oauth token refresh" });
    const ids = JSON.parse(res.content[0].text).map((h: { id: string }) => h.id);
    expect(ids).toEqual(["github:1"]);
  });
});

describe("runGetMemory", () => {
  it("returns the full record for an in-scope id", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", REPO_A));
    const res = await runGetMemory({ repo: REPO_A, memoryDir }, { id: "github:1" });
    expect(JSON.parse(res.content[0].text).itemId).toBe("github:1");
  });

  it("refuses an id belonging to another repo", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:2", REPO_B));
    const res = await runGetMemory({ repo: REPO_A, memoryDir }, { id: "github:2" });
    expect(res.content[0].text).toContain("No memory record found");
  });

  it("errors on a missing id", async () => {
    const res = await runGetMemory({ repo: REPO_A, memoryDir }, {});
    expect(res.isError).toBe(true);
  });
});
