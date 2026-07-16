import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCursors, saveCursors, parseCursorFile, type InboxCursorFile } from "../src/inbox-cursor-store";

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "inbox-cursor-"));
  return join(dir, "inbox-cursors.json");
}

const GITHUB_CURSOR = {
  version: 1,
  assigned: { since: "2026-07-10T00:00:00Z", etags: { "https://api.github.com/issues?x": 'W/"a"' } },
  created: { etags: {} },
  lastPolledAt: "2026-07-10T01:00:00Z",
};

const SAMPLE: InboxCursorFile = {
  version: 2,
  platforms: { github: { "45292355": GITHUB_CURSOR } },
};

const LEGACY_V1 = {
  version: 1,
  github: { "45292355": GITHUB_CURSOR },
};

describe("inbox cursor store", () => {
  it("round-trips save and load", async () => {
    const path = await tempFile();
    await saveCursors(path, SAMPLE);
    await expect(loadCursors(path)).resolves.toEqual(SAMPLE);
  });

  it("returns a fresh file when missing or corrupt", async () => {
    const path = await tempFile();
    await expect(loadCursors(path)).resolves.toEqual({ version: 2, platforms: {} });
    await writeFile(path, "not json", "utf-8");
    await expect(loadCursors(path)).resolves.toEqual({ version: 2, platforms: {} });
    await writeFile(path, JSON.stringify({ version: 99 }), "utf-8");
    await expect(loadCursors(path)).resolves.toEqual({ version: 2, platforms: {} });
  });

  it("migrates a legacy v1 file preserving the cursors and rewrites it on disk", async () => {
    const path = await tempFile();
    await writeFile(path, JSON.stringify(LEGACY_V1), "utf-8");
    const loaded = await loadCursors(path);
    expect(loaded.version).toBe(2);
    expect(loaded.platforms.github).toEqual(LEGACY_V1.github);
    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    expect(onDisk).toEqual({ version: 2, platforms: { github: LEGACY_V1.github } });
  });

  it("parseCursorFile flags migration and rejects garbage", () => {
    expect(parseCursorFile(JSON.stringify(SAMPLE))).toEqual({ file: SAMPLE, migrated: false });
    expect(parseCursorFile(JSON.stringify(LEGACY_V1))).toEqual({
      file: { version: 2, platforms: { github: LEGACY_V1.github } },
      migrated: true,
    });
    expect(parseCursorFile("not json")).toBeNull();
    expect(parseCursorFile("null")).toBeNull();
    expect(parseCursorFile(JSON.stringify({ version: 99 }))).toBeNull();
    expect(parseCursorFile(JSON.stringify({ version: 1, github: null }))).toBeNull();
  });

  it("serializes concurrent saves and leaves no tmp files behind", async () => {
    const path = await tempFile();
    const versions = Array.from({ length: 10 }, (_, i) => ({
      version: 2 as const,
      platforms: {
        github: { ...SAMPLE.platforms.github, marker: { assigned: { etags: { i: String(i) } } } },
      },
    }));
    await Promise.all(versions.map((v) => saveCursors(path, v)));
    const loaded = await loadCursors(path);
    expect((loaded.platforms.github?.marker as { assigned: { etags: { i: string } } }).assigned.etags.i).toBe("9");
    const files = await readdir(join(path, ".."));
    expect(files).toEqual(["inbox-cursors.json"]);
    expect(JSON.parse(await readFile(path, "utf-8")).version).toBe(2);
  });
});
