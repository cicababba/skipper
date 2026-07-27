import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolutionRecord } from "@skipper/shared";
import {
  registerTransformersLoader,
  writeSolutionRecord,
  reconcileMemoryIndex,
  createNoteRecord,
  memoryFileName,
  searchMemory,
} from "@skipper/core";
import { displayKey } from "@skipper/shared";
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

describe("runSearchMemory — manual notes (#255)", () => {
  it("serializes a pr-less note hit with its kind and no pr key", async () => {
    const note = createNoteRecord(REPO_A, "always debounce the pty resize", ["src/terminal.ts"]);
    await writeSolutionRecord(memoryDir, note);
    await reconcileMemoryIndex(memoryDir);

    const res = await runSearchMemory(
      { repo: REPO_A, memoryDir },
      { query: "debounce the pty resize" },
    );
    expect(res.isError).toBeUndefined();
    const hits = JSON.parse(res.content[0].text) as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(note.itemId);
    expect(hits[0].kind).toBe("note");
    expect(hits[0].issue).toBe("");
    expect("pr" in hits[0]).toBe(false);
    expect(hits[0].filesTouched).toEqual(["src/terminal.ts"]);
  });

  it("formats the note line the way the CLI printer does, without PR #undefined", async () => {
    const note = createNoteRecord(REPO_A, "always debounce the pty resize");
    await writeSolutionRecord(memoryDir, note);
    await reconcileMemoryIndex(memoryDir);

    const hits = await searchMemory(memoryDir, "debounce the pty resize", { repo: REPO_A });
    // Mirrors the `memory search` printer in ./index.ts.
    const head = `${displayKey(hits[0].issueKey) || "(note)"} ${hits[0].title}`;
    const origin = hits[0].pr ? `PR #${hits[0].pr.number}` : "note";
    expect(head).toBe("(note) always debounce the pty resize");
    expect(origin).toBe("note");
  });

  it("serves notes and solutions from one corpus, each to its own query", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", REPO_A));
    const note = createNoteRecord(REPO_A, "terminal resize race on windows");
    await writeSolutionRecord(memoryDir, note);
    await reconcileMemoryIndex(memoryDir);

    const ids = async (query: string) => {
      const res = await runSearchMemory({ repo: REPO_A, memoryDir }, { query });
      return (JSON.parse(res.content[0].text) as Array<{ id: string }>).map((h) => h.id);
    };
    expect((await ids("terminal resize race on windows"))[0]).toBe(note.itemId);
    expect((await ids("fix oauth token refresh"))[0]).toBe("github:1");
  });
});

describe("runGetMemory", () => {
  it("returns a note record in full for its note: id", async () => {
    const note = createNoteRecord(REPO_A, "body worth keeping", ["src/a.ts"], "Keepsake");
    await writeSolutionRecord(memoryDir, note);

    const res = await runGetMemory({ repo: REPO_A, memoryDir }, { id: note.itemId });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.itemId).toBe(note.itemId);
    expect(parsed.kind).toBe("note");
    expect(parsed.title).toBe("Keepsake");
    expect(parsed.note).toEqual({ body: "body worth keeping", files: ["src/a.ts"] });
  });

  it("keeps notes inside their repo scope", async () => {
    const note = createNoteRecord(REPO_B, "anvil wisdom");
    await writeSolutionRecord(memoryDir, note);
    const res = await runGetMemory({ repo: REPO_A, memoryDir }, { id: note.itemId });
    expect(res.content[0].text).toContain("No memory record found");
  });

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

// Usage tracking (#256): the serve subprocess is the only writer of these
// counters — the Memory tab's own searches deliberately do not count.
describe("usage counters", () => {
  const readRecord = async (id: string): Promise<SolutionRecord> =>
    JSON.parse(await readFile(join(memoryDir, memoryFileName(id)), "utf-8")) as SolutionRecord;

  it("bumps offered on exactly the records the agent was shown", async () => {
    for (let i = 0; i < 4; i++) {
      await writeSolutionRecord(memoryDir, makeRecord(`github:${i}`, REPO_A));
    }
    await reconcileMemoryIndex(memoryDir);

    const res = await runSearchMemory(
      { repo: REPO_A, memoryDir },
      { query: "fix oauth token refresh", k: 2 },
    );
    const shown = (JSON.parse(res.content[0].text) as Array<{ id: string }>).map((h) => h.id);
    expect(shown).toHaveLength(2);

    for (let i = 0; i < 4; i++) {
      const rec = await readRecord(`github:${i}`);
      if (shown.includes(`github:${i}`)) {
        expect(rec.offeredCount).toBe(1);
        expect(Date.parse(rec.lastOfferedAt!)).not.toBeNaN();
      } else {
        expect(rec.offeredCount).toBeUndefined();
      }
    }
  });

  it("accumulates offers across searches and never touches fetched", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", REPO_A));
    await reconcileMemoryIndex(memoryDir);

    await runSearchMemory({ repo: REPO_A, memoryDir }, { query: "fix oauth token refresh" });
    await runSearchMemory({ repo: REPO_A, memoryDir }, { query: "fix oauth token refresh" });

    const rec = await readRecord("github:1");
    expect(rec.offeredCount).toBe(2);
    expect(rec.fetchedCount).toBeUndefined();
  });

  it("bumps nothing when the search returns nothing", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", REPO_B));
    await reconcileMemoryIndex(memoryDir);

    await runSearchMemory({ repo: REPO_A, memoryDir }, { query: "fix oauth token refresh" });
    expect((await readRecord("github:1")).offeredCount).toBeUndefined();
  });

  it("bumps fetched when a record is actually read", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1", REPO_A));

    await runGetMemory({ repo: REPO_A, memoryDir }, { id: "github:1" });
    await runGetMemory({ repo: REPO_A, memoryDir }, { id: "github:1" });

    const rec = await readRecord("github:1");
    expect(rec.fetchedCount).toBe(2);
    expect(Date.parse(rec.lastFetchedAt!)).not.toBeNaN();
  });

  it("does not bump a record the scope guard refused", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:2", REPO_B));

    const res = await runGetMemory({ repo: REPO_A, memoryDir }, { id: "github:2" });
    expect(res.content[0].text).toContain("No memory record found");
    expect((await readRecord("github:2")).fetchedCount).toBeUndefined();
  });

  // A counter is worth less than a retrieval: an unwritable memory dir must
  // still serve hits.
  it.skipIf(process.getuid?.() === 0)(
    "serves the tool result even when the counter write fails",
    async () => {
      await writeSolutionRecord(memoryDir, makeRecord("github:1", REPO_A));
      await reconcileMemoryIndex(memoryDir);
      await chmod(memoryDir, 0o555);
      try {
        const search = await runSearchMemory(
          { repo: REPO_A, memoryDir },
          { query: "fix oauth token refresh" },
        );
        expect(search.isError).toBeUndefined();
        expect(JSON.parse(search.content[0].text)).toHaveLength(1);

        const get = await runGetMemory({ repo: REPO_A, memoryDir }, { id: "github:1" });
        expect(get.isError).toBeUndefined();
        expect(JSON.parse(get.content[0].text).itemId).toBe("github:1");
      } finally {
        await chmod(memoryDir, 0o755);
      }
    },
  );
});
