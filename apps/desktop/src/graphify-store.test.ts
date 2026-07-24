import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GraphifyDoc } from "@skipper/shared";
import {
  clearGraphifyRunning,
  graphifyFileKey,
  graphPathFor,
  graphifyRepoDir,
  isGraphifyRunning,
  loadGraphifyDoc,
  markGraphifyRunning,
  markStaleGraphifyRuns,
  readReadyGraph,
  saveGraphifyDoc,
} from "./graphify-store";

const KEY = "acme/widgets";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-graphify-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function doc(overrides: Partial<GraphifyDoc> = {}): GraphifyDoc {
  return {
    version: 1,
    status: "ready",
    indexedSha: "abc123",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

/** Create the on-disk graph.json for a repo so readReadyGraph's file check passes. */
async function writeGraphFile(repoKey: string): Promise<string> {
  const path = graphPathFor(dir, repoKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}", "utf-8");
  return path;
}

describe("graphify-store paths", () => {
  it("sanitizes the file key from the repoKey", () => {
    expect(graphifyFileKey("acme/widgets")).toBe("acme_widgets");
    expect(graphifyFileKey("a:b/c*d")).toBe("a_b_c_d");
  });

  it("derives the repo dir and the graph.json path under graphify-out", () => {
    expect(graphifyRepoDir("/g", KEY)).toBe(join("/g", "acme_widgets"));
    expect(graphPathFor("/g", KEY)).toBe(
      join("/g", "acme_widgets", "graphify-out", "graph.json"),
    );
  });
});

describe("save / load", () => {
  it("round-trips a doc", async () => {
    await saveGraphifyDoc(dir, KEY, doc());
    await expect(loadGraphifyDoc(dir, KEY)).resolves.toEqual(doc());
  });

  it("returns null when missing", async () => {
    await expect(loadGraphifyDoc(dir, KEY)).resolves.toBeNull();
  });

  it("keeps the last write when saves are queued for the same repo", async () => {
    await Promise.all([
      saveGraphifyDoc(dir, KEY, doc({ status: "installing", indexedSha: undefined })),
      saveGraphifyDoc(dir, KEY, doc({ status: "indexing", indexedSha: undefined })),
      saveGraphifyDoc(dir, KEY, doc({ status: "ready", indexedSha: "final" })),
    ]);
    const loaded = await loadGraphifyDoc(dir, KEY);
    expect(loaded?.status).toBe("ready");
    expect(loaded?.indexedSha).toBe("final");
  });
});

describe("running set", () => {
  it("gates on the in-memory set, not disk", () => {
    expect(isGraphifyRunning(KEY)).toBe(false);
    markGraphifyRunning(KEY);
    expect(isGraphifyRunning(KEY)).toBe(true);
    clearGraphifyRunning(KEY);
    expect(isGraphifyRunning(KEY)).toBe(false);
  });
});

describe("readReadyGraph — last-good-graph rule", () => {
  it("returns the graph for a ready doc whose graph.json exists", async () => {
    await saveGraphifyDoc(dir, KEY, doc({ status: "ready", indexedSha: "sha1" }));
    const path = await writeGraphFile(KEY);
    await expect(readReadyGraph(dir, KEY)).resolves.toEqual({
      indexedSha: "sha1",
      graphPath: path,
    });
  });

  it("still returns the previous good graph even when status is failed", async () => {
    // A failed re-index preserves the prior indexedSha — status gates only the UI.
    await saveGraphifyDoc(
      dir,
      KEY,
      doc({ status: "failed", indexedSha: "sha1", error: "boom" }),
    );
    await writeGraphFile(KEY);
    const ready = await readReadyGraph(dir, KEY);
    expect(ready?.indexedSha).toBe("sha1");
  });

  it("returns undefined when the doc has an indexedSha but graph.json is missing", async () => {
    await saveGraphifyDoc(dir, KEY, doc({ status: "ready", indexedSha: "sha1" }));
    await expect(readReadyGraph(dir, KEY)).resolves.toBeUndefined();
  });

  it("returns undefined when no doc exists", async () => {
    await expect(readReadyGraph(dir, KEY)).resolves.toBeUndefined();
  });

  it("returns undefined when the doc carries no indexedSha", async () => {
    await saveGraphifyDoc(dir, KEY, doc({ status: "indexing", indexedSha: undefined }));
    await writeGraphFile(KEY);
    await expect(readReadyGraph(dir, KEY)).resolves.toBeUndefined();
  });
});

describe("markStaleGraphifyRuns", () => {
  it("flips installing and indexing docs to failed, leaving ready alone", async () => {
    await saveGraphifyDoc(dir, "a/installing", doc({ status: "installing", indexedSha: undefined, runStartedAt: "t" }));
    await saveGraphifyDoc(dir, "a/indexing", doc({ status: "indexing", indexedSha: "old", runStartedAt: "t" }));
    await saveGraphifyDoc(dir, "a/ready", doc({ status: "ready", indexedSha: "good" }));

    await markStaleGraphifyRuns(dir);

    const installing = await loadGraphifyDoc(dir, "a/installing");
    expect(installing?.status).toBe("failed");
    expect(installing?.error).toContain("interrupted by app restart");
    expect(installing?.runStartedAt).toBeUndefined();

    const indexing = await loadGraphifyDoc(dir, "a/indexing");
    expect(indexing?.status).toBe("failed");
    // The previous good SHA survives the flip (last-good-graph rule).
    expect(indexing?.indexedSha).toBe("old");

    expect((await loadGraphifyDoc(dir, "a/ready"))?.status).toBe("ready");
  });

  it("tolerates a missing directory", async () => {
    await expect(markStaleGraphifyRuns(join(dir, "nope"))).resolves.toBeUndefined();
  });
});
