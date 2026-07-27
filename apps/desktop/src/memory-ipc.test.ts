import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoRef, SolutionRecord } from "@skipper/shared";
import {
  registerTransformersLoader,
  writeSolutionRecord,
  memoryFileName,
  type OrchestratorManifest,
} from "@skipper/core";
import { registerMemoryHandlers, type MemoryIpcDeps } from "./memory-ipc";

// The #255 memory handlers against a real on-disk store with a fake ipcMain
// (pattern from export-ipc.test.ts) and the deterministic bag-of-words embedder
// from core's memory.test.ts — no Electron, no model download.

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

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const REPO: RepoRef = { owner: "acme", name: "rocket" };

interface SearchResult {
  ok: boolean;
  error?: string;
  hits?: Array<{
    id: string;
    kind?: string;
    pr?: unknown;
    issueKey: string;
    filesTouched: string[];
  }>;
}

let memoryDir: string;

function makeRecord(itemId: string, overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 1,
    itemId,
    repo: REPO,
    issueNumber: 7,
    title: "fix oauth token refresh",
    url: "https://example.test/7",
    pr: { number: 8, url: "https://example.test/pr/8" },
    diffStats: { filesChanged: 1, totalChangedLines: 10, files: ["src/auth/oauth.ts"] },
    outcome: "merged",
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

interface SetupOptions {
  localPath?: string | undefined;
  git?: { code: number; stdout: string; stderr: string };
}

function setup(opts: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const broadcast = vi.fn();
  const manifest = { items: {} } as unknown as OrchestratorManifest;
  const localPathFor = vi.fn(async () =>
    "localPath" in opts ? opts.localPath : "/clones/rocket",
  );
  const runGit = vi.fn(async () => opts.git ?? { code: 0, stdout: "", stderr: "" });
  const deps = {
    ipcMain,
    memoryDir,
    manifestFilePath: join(memoryDir, "manifest.json"),
    ensureManifest: async () => manifest,
    broadcast,
    localPathFor,
    runGit,
  } as unknown as MemoryIpcDeps;
  registerMemoryHandlers(deps);

  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`handler not registered: ${channel}`);
    return handler(null, ...args);
  };
  return { call, broadcast, localPathFor, runGit };
}

const readRecord = async (id: string): Promise<SolutionRecord> =>
  JSON.parse(await readFile(join(memoryDir, memoryFileName(id)), "utf-8")) as SolutionRecord;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "skipper-memipc-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("skipper:memory:curate", () => {
  it("walks up → down → off, moving the counters and the stored anchor", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    const { call, broadcast } = setup();

    expect(await call("skipper:memory:curate", "github:1", "up")).toEqual({ ok: true });
    let rec = await readRecord("github:1");
    expect(rec.feedback).toEqual({ up: 1, down: 0 });
    expect(rec.curationVote).toBe("up");

    expect(await call("skipper:memory:curate", "github:1", "down")).toEqual({ ok: true });
    rec = await readRecord("github:1");
    expect(rec.feedback).toEqual({ up: 0, down: 1 });
    expect(rec.curationVote).toBe("down");

    expect(await call("skipper:memory:curate", "github:1", null)).toEqual({ ok: true });
    rec = await readRecord("github:1");
    expect(rec.feedback).toEqual({ up: 0, down: 0 });
    expect(rec.curationVote).toBeUndefined();

    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it("treats a repeated vote as a no-op and does not broadcast", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    const { call, broadcast } = setup();

    await call("skipper:memory:curate", "github:1", "up");
    broadcast.mockClear();

    expect(await call("skipper:memory:curate", "github:1", "up")).toEqual({ ok: true });
    expect((await readRecord("github:1")).feedback).toEqual({ up: 1, down: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("fails on an unknown id without touching the store", async () => {
    const { call, broadcast } = setup();
    expect(await call("skipper:memory:curate", "github:404", "up")).toEqual({
      ok: false,
      error: 'no memory record for id "github:404"',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("needs no manifest entry — a never-consulted record is curatable", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    const { call } = setup();
    expect(await call("skipper:memory:curate", "github:1", "up")).toEqual({ ok: true });
  });
});

describe("skipper:memory:createNote", () => {
  it("writes the note to disk and makes it searchable immediately", async () => {
    const { call, broadcast } = setup();
    const created = (await call(
      "skipper:memory:createNote",
      REPO,
      "always debounce the pty resize",
      ["src/terminal.ts"],
      "PTY resize",
    )) as { ok: boolean; id: string };
    expect(created.ok).toBe(true);
    expect(created.id.startsWith("note:")).toBe(true);
    expect(broadcast).toHaveBeenCalled();

    const onDisk = await readRecord(created.id);
    expect(onDisk.kind).toBe("note");
    expect(onDisk.title).toBe("PTY resize");
    expect(onDisk.note).toEqual({
      body: "always debounce the pty resize",
      files: ["src/terminal.ts"],
    });

    // Inline indexing: findable without any reconcile pass.
    const res = (await call(
      "skipper:memory:search",
      REPO,
      "debounce the pty resize",
    )) as SearchResult;
    expect(res.ok).toBe(true);
    expect(res.hits?.[0]).toMatchObject({
      id: created.id,
      kind: "note",
      issueKey: "",
      filesTouched: ["src/terminal.ts"],
    });
    expect(res.hits?.[0].pr).toBeUndefined();
  });

  it("rejects an empty body and writes nothing", async () => {
    const { call, broadcast } = setup();
    expect(await call("skipper:memory:createNote", REPO, "   ")).toEqual({
      ok: false,
      error: "note body is empty",
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(await call("skipper:memory:list", REPO)).toEqual([]);
  });

  it("shows up in the repo's list, scoped to that repo", async () => {
    const { call } = setup();
    await call("skipper:memory:createNote", REPO, "rocket wisdom");
    expect(await call("skipper:memory:list", { owner: "acme", name: "anvil" })).toEqual([]);
    expect((await call("skipper:memory:list", REPO)) as SolutionRecord[]).toHaveLength(1);
  });
});

describe("skipper:memory:updateNote", () => {
  it("re-embeds so the new body is findable and the replaced one is not", async () => {
    const { call } = setup();
    // Fixed title: the index embeds "<title>. <body>", so a derived title would
    // keep the old wording searchable no matter what the body says.
    const created = (await call(
      "skipper:memory:createNote",
      REPO,
      "original caching wisdom",
      undefined,
      "Note",
    )) as { id: string };

    expect(
      await call("skipper:memory:updateNote", created.id, "rewritten throttling wisdom", undefined, "Note"),
    ).toEqual({ ok: true });
    expect((await readRecord(created.id)).note).toEqual({ body: "rewritten throttling wisdom" });

    const found = (await call("skipper:memory:search", REPO, "rewritten throttling")) as SearchResult;
    expect(found.hits?.map((h) => h.id)).toEqual([created.id]);

    const gone = (await call("skipper:memory:search", REPO, "original caching")) as SearchResult;
    expect(gone.hits?.map((h) => h.id)).not.toContain(created.id);
  });

  it("keeps a body-derived title searchable after the body is rewritten", async () => {
    const { call } = setup();
    const created = (await call("skipper:memory:createNote", REPO, "original caching wisdom")) as {
      id: string;
    };
    await call("skipper:memory:updateNote", created.id, "rewritten throttling wisdom");

    // The title still reads "original caching wisdom" and the index embeds it,
    // so the note stays reachable by its original phrasing until it is renamed.
    expect((await readRecord(created.id)).title).toBe("original caching wisdom");
    const res = (await call("skipper:memory:search", REPO, "original caching")) as SearchResult;
    expect(res.hits?.map((h) => h.id)).toEqual([created.id]);
  });

  it("replaces the linked files and keeps the title when none is given", async () => {
    const { call } = setup();
    const created = (await call(
      "skipper:memory:createNote",
      REPO,
      "body",
      ["src/a.ts"],
      "Keepsake",
    )) as { id: string };

    await call("skipper:memory:updateNote", created.id, "body", ["src/b.ts"]);
    const rec = await readRecord(created.id);
    expect(rec.note).toEqual({ body: "body", files: ["src/b.ts"] });
    expect(rec.title).toBe("Keepsake");

    await call("skipper:memory:updateNote", created.id, "body", [], "Renamed");
    const renamed = await readRecord(created.id);
    expect(renamed.note).toEqual({ body: "body" });
    expect(renamed.title).toBe("Renamed");
  });

  it("refuses a captured solution record", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    const { call } = setup();
    expect(await call("skipper:memory:updateNote", "github:1", "hijacked")).toEqual({
      ok: false,
      error: "not a note",
    });
    expect((await readRecord("github:1")).note).toBeUndefined();
  });

  it("refuses an empty body and an unknown id", async () => {
    const { call } = setup();
    const created = (await call("skipper:memory:createNote", REPO, "keep me")) as { id: string };

    expect(await call("skipper:memory:updateNote", created.id, "  ")).toEqual({
      ok: false,
      error: "note body is empty",
    });
    expect((await readRecord(created.id)).note).toEqual({ body: "keep me" });

    expect(await call("skipper:memory:updateNote", "note:missing", "body")).toEqual({
      ok: false,
      error: 'no memory record for id "note:missing"',
    });
  });
});

describe("skipper:memory:search", () => {
  it("lazily indexes records written straight to the store", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    const { call } = setup();

    const res = (await call("skipper:memory:search", REPO, "fix oauth token refresh")) as SearchResult;
    expect(res.ok).toBe(true);
    expect(res.hits?.map((h) => h.id)).toEqual(["github:1"]);
  });

  it("reconciles once per session, not once per query", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    const { call } = setup();

    await call("skipper:memory:search", REPO, "fix oauth token refresh");
    // A record added after the memoized reconcile stays invisible until the
    // next session — the inline index path is what keeps new notes findable.
    await writeSolutionRecord(memoryDir, makeRecord("github:2", { title: "second capture" }));
    const res = (await call("skipper:memory:search", REPO, "fix oauth token refresh")) as SearchResult;
    expect(res.hits?.map((h) => h.id)).toEqual(["github:1"]);
  });

  it("honours the k cap", async () => {
    for (let i = 0; i < 5; i++) await writeSolutionRecord(memoryDir, makeRecord(`github:${i}`));
    const { call } = setup();
    const res = (await call("skipper:memory:search", REPO, "fix oauth token refresh", 2)) as SearchResult;
    expect(res.hits).toHaveLength(2);
  });

  it("scopes results to the requested repo", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await writeSolutionRecord(
      memoryDir,
      makeRecord("github:2", { repo: { owner: "acme", name: "anvil" } }),
    );
    const { call } = setup();
    const res = (await call("skipper:memory:search", REPO, "fix oauth token refresh")) as SearchResult;
    expect(res.hits?.map((h) => h.id)).toEqual(["github:1"]);
  });
});

describe("skipper:memory:repoFiles", () => {
  it("splits git ls-files output and drops the trailing blank", async () => {
    const { call, runGit } = setup({ git: { code: 0, stdout: "a/b.ts\nc.ts\n", stderr: "" } });
    expect(await call("skipper:memory:repoFiles", REPO)).toEqual({
      ok: true,
      files: ["a/b.ts", "c.ts"],
    });
    expect(runGit).toHaveBeenCalledWith("/clones/rocket", ["ls-files"]);
  });

  it("reports an unlinked repo without shelling out", async () => {
    const { call, runGit } = setup({ localPath: undefined });
    expect(await call("skipper:memory:repoFiles", REPO)).toEqual({
      ok: false,
      error: "repo not linked",
    });
    expect(runGit).not.toHaveBeenCalled();
  });

  it("surfaces git's stderr on a nonzero exit", async () => {
    const { call } = setup({ git: { code: 128, stdout: "", stderr: "not a git repository\n" } });
    expect(await call("skipper:memory:repoFiles", REPO)).toEqual({
      ok: false,
      error: "not a git repository",
    });
  });

  it("falls back to a generic message when git fails silently", async () => {
    const { call } = setup({ git: { code: 1, stdout: "", stderr: "" } });
    expect(await call("skipper:memory:repoFiles", REPO)).toEqual({
      ok: false,
      error: "git ls-files failed",
    });
  });
});

describe("skipper:memory:delete", () => {
  it("removes an unindexed record without throwing (regression for the reconcile trap)", async () => {
    await writeSolutionRecord(memoryDir, makeRecord("github:1"));
    await writeSolutionRecord(memoryDir, makeRecord("github:2"));
    const { call } = setup();

    expect(await call("skipper:memory:delete", "github:1")).toEqual({ ok: true });
    expect((await call("skipper:memory:list", REPO)) as SolutionRecord[]).toHaveLength(1);
  });
});
