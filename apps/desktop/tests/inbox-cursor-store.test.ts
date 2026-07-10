import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCursors, saveCursors, type InboxCursorFile } from "../src/inbox-cursor-store";

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "inbox-cursor-"));
  return join(dir, "inbox-cursors.json");
}

const SAMPLE: InboxCursorFile = {
  version: 1,
  github: {
    "45292355": {
      version: 1,
      assigned: { since: "2026-07-10T00:00:00Z", etags: { "https://api.github.com/issues?x": 'W/"a"' } },
      created: { etags: {} },
      lastPolledAt: "2026-07-10T01:00:00Z",
    },
  },
};

describe("inbox cursor store", () => {
  it("round-trips save and load", async () => {
    const path = await tempFile();
    await saveCursors(path, SAMPLE);
    await expect(loadCursors(path)).resolves.toEqual(SAMPLE);
  });

  it("returns a fresh file when missing or corrupt", async () => {
    const path = await tempFile();
    await expect(loadCursors(path)).resolves.toEqual({ version: 1, github: {} });
    await writeFile(path, "not json", "utf-8");
    await expect(loadCursors(path)).resolves.toEqual({ version: 1, github: {} });
    await writeFile(path, JSON.stringify({ version: 99 }), "utf-8");
    await expect(loadCursors(path)).resolves.toEqual({ version: 1, github: {} });
  });

  it("serializes concurrent saves and leaves no tmp files behind", async () => {
    const path = await tempFile();
    const versions = Array.from({ length: 10 }, (_, i) => ({
      ...SAMPLE,
      github: { ...SAMPLE.github, marker: { version: 1 as const, assigned: { etags: { i: String(i) } }, created: { etags: {} } } },
    }));
    await Promise.all(versions.map((v) => saveCursors(path, v)));
    const loaded = await loadCursors(path);
    expect(loaded.github.marker.assigned.etags.i).toBe("9");
    const files = await readdir(join(path, ".."));
    expect(files).toEqual(["inbox-cursors.json"]);
    expect(JSON.parse(await readFile(path, "utf-8")).version).toBe(1);
  });
});
