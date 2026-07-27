import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoteRecord } from "./notes";
import { buildEmbedText } from "./indexer";
import { listSolutionRecords, memoryFileName, readSolutionRecord, writeSolutionRecord } from "./store";

// Manual notes (#255) ride the SolutionRecord shape without any of the capture
// fields. Pure module — no embedder needed here.

const REPO = { owner: "acme", name: "rocket" };

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "skipper-notes-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

describe("createNoteRecord", () => {
  it("builds a v1 note with none of the capture fields", () => {
    const rec = createNoteRecord(REPO, "the pty resize race needs a debounce");
    expect(rec.version).toBe(1);
    expect(rec.kind).toBe("note");
    expect(rec.repo).toEqual(REPO);
    expect(rec.note).toEqual({ body: "the pty resize race needs a debounce" });
    expect(rec.url).toBe("");
    expect(rec.pr).toBeUndefined();
    expect(rec.outcome).toBeUndefined();
    expect(rec.plan).toBeUndefined();
    expect(rec.issueKey).toBeUndefined();
    expect(rec.issueNumber).toBeUndefined();
    expect(Date.parse(rec.capturedAt)).not.toBeNaN();
  });

  it("prefixes the itemId with note: and makes it unique per call", () => {
    const a = createNoteRecord(REPO, "one");
    const b = createNoteRecord(REPO, "two");
    expect(a.itemId.startsWith("note:")).toBe(true);
    expect(a.itemId).not.toBe(b.itemId);
  });

  it("defaults the title to the first body line", () => {
    const rec = createNoteRecord(REPO, "  first line\nsecond line\nthird  ");
    expect(rec.title).toBe("first line");
  });

  it("caps a derived title at 80 chars", () => {
    const rec = createNoteRecord(REPO, "x".repeat(200));
    expect(rec.title).toHaveLength(80);
  });

  it("prefers an explicit title, trimmed", () => {
    const rec = createNoteRecord(REPO, "body text", undefined, "  Real title  ");
    expect(rec.title).toBe("Real title");
  });

  it("falls back to the body when the explicit title is blank", () => {
    const rec = createNoteRecord(REPO, "body text", undefined, "   ");
    expect(rec.title).toBe("body text");
  });

  it("attaches files only when some are given", () => {
    expect(createNoteRecord(REPO, "b", ["src/a.ts", "src/b.ts"]).note).toEqual({
      body: "b",
      files: ["src/a.ts", "src/b.ts"],
    });
    expect(createNoteRecord(REPO, "b", []).note).toEqual({ body: "b" });
  });
});

describe("note persistence", () => {
  it("round-trips through the store and passes the version gate", async () => {
    const rec = createNoteRecord(REPO, "debounce the resize", ["src/terminal.ts"], "PTY resize");
    const ref = await writeSolutionRecord(memoryDir, rec);

    const back = await readSolutionRecord(memoryDir, ref);
    expect(back).toEqual(rec);

    const entries = await listSolutionRecords(memoryDir);
    expect(entries.map((e) => e.record.itemId)).toEqual([rec.itemId]);
  });

  it("sanitizes the note: colon out of the filename (Windows)", () => {
    const name = memoryFileName("note:3f2a-9c1b");
    expect(name).not.toContain(":");
    expect(name).toBe("note_3f2a-9c1b.json");
  });
});

describe("buildEmbedText — note branch", () => {
  it("embeds the body and the linked files", () => {
    const rec = createNoteRecord(REPO, "always debounce the resize", ["src/terminal.ts"]);
    expect(buildEmbedText(rec)).toBe("always debounce the resize\nsrc/terminal.ts");
  });

  it("embeds the body alone when no files are linked", () => {
    const rec = createNoteRecord(REPO, "always debounce the resize");
    expect(buildEmbedText(rec)).toBe("always debounce the resize");
  });

  it("never returns empty for a note, unlike a planless solution record", () => {
    const note = createNoteRecord(REPO, "something worth remembering");
    expect(buildEmbedText(note)).not.toBe("");
    expect(
      buildEmbedText({
        version: 1,
        itemId: "github:1",
        repo: REPO,
        title: "planless",
        url: "https://example.test/1",
        capturedAt: "2026-07-10T00:00:00.000Z",
      }),
    ).toBe("");
  });
});
