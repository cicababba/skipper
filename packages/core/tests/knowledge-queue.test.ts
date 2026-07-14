import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queuePaths,
  ensureQueueDirs,
  writePendingAtom,
  listPending,
  acceptAtom,
  rejectAtom,
  updatePendingAtom,
} from "../src/knowledge/queue";
import type { KnowledgeAtom } from "../src/knowledge/atom";

function atom(overrides: Partial<KnowledgeAtom> = {}): KnowledgeAtom {
  return {
    id: "test-atom",
    title: "Test atom",
    project: "proj",
    created: "2026-07-14",
    score: 7,
    tags: ["a"],
    sourceRefs: [],
    body: "Body text.",
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skipper-knowledge-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("queuePaths", () => {
  it("builds pending/rejected/accepted directly under the knowledge root", () => {
    const p = queuePaths(root);
    expect(p.pending).toBe(join(root, "pending"));
    expect(p.rejected).toBe(join(root, "rejected"));
    expect(p.acceptedRoot).toBe(join(root, "accepted"));
  });

  it("never references a .skipper segment", () => {
    const p = queuePaths(root);
    for (const path of [p.pending, p.rejected, p.acceptedRoot]) {
      expect(path).not.toContain(".skipper");
    }
  });
});

describe("queue operations", () => {
  it("ensureQueueDirs creates all three dirs idempotently", async () => {
    const p = await ensureQueueDirs(root);
    await ensureQueueDirs(root);
    for (const dir of [p.pending, p.rejected, p.acceptedRoot]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("writePendingAtom lands the atom in pending/ and listPending reads it back", async () => {
    const file = await writePendingAtom(root, atom());
    expect(file.startsWith(join(root, "pending"))).toBe(true);
    const entries = await listPending(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].atom.title).toBe("Test atom");
  });

  it("listPending returns [] for a root that does not exist yet", async () => {
    expect(await listPending(join(root, "missing"))).toEqual([]);
  });

  it("listPending sorts by score desc, then created desc", async () => {
    await writePendingAtom(root, atom({ id: "low", title: "low", score: 2 }));
    await writePendingAtom(root, atom({ id: "old", title: "old", score: 9, created: "2026-01-01" }));
    await writePendingAtom(root, atom({ id: "new", title: "new", score: 9, created: "2026-07-01" }));
    const entries = await listPending(root);
    expect(entries.map((e) => e.atom.title)).toEqual(["new", "old", "low"]);
  });

  it("acceptAtom moves the file into accepted/<project>/", async () => {
    await writePendingAtom(root, atom({ project: "myrepo" }));
    const [entry] = await listPending(root);
    const dest = await acceptAtom(root, entry);
    expect(dest.startsWith(join(root, "accepted", "myrepo"))).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(entry.filePath)).toBe(false);
    expect(await listPending(root)).toHaveLength(0);
  });

  it("rejectAtom moves the file into rejected/ without deleting it", async () => {
    await writePendingAtom(root, atom());
    const [entry] = await listPending(root);
    const dest = await rejectAtom(root, entry);
    expect(dest.startsWith(join(root, "rejected"))).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(await listPending(root)).toHaveLength(0);
  });

  it("updatePendingAtom rewrites content and renames when the slug changes", async () => {
    await writePendingAtom(root, atom());
    const [entry] = await listPending(root);
    const next = await updatePendingAtom(entry.filePath, {
      ...entry.atom,
      id: "renamed-atom",
      title: "Renamed atom",
    });
    expect(next).not.toBe(entry.filePath);
    expect(existsSync(next)).toBe(true);
    expect(await readFile(next, "utf-8")).toContain("Renamed atom");
    const names = await readdir(queuePaths(root).pending);
    expect(names).toHaveLength(1);
  });
});
