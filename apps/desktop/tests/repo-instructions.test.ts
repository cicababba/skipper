import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  instructionsFileName,
  loadRepoInstructions,
  saveRepoInstructions,
  seedRepoInstructions,
  isInstructionsGenerating,
  markStaleGenerations,
  readReadyInstructions,
} from "../src/repo-instructions";
import type { RepoInstructionsDoc } from "@skipper/shared";

const REPO_KEY = "acme/widgets";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** A repoPath with or without a CLAUDE.md. */
async function repoWith(claudeMd?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repo-instr-repo-"));
  if (claudeMd !== undefined) await writeFile(join(dir, "CLAUDE.md"), claudeMd, "utf-8");
  return dir;
}

/** A promise plus its resolve/reject, so a test can settle generation on demand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("repo-instructions store", () => {
  it("sanitizes the filename from the repoKey", () => {
    expect(instructionsFileName("acme/widgets")).toBe("acme_widgets.json");
    expect(instructionsFileName("a:b/c*d")).toBe("a_b_c_d.json");
  });

  it("round-trips save and load", async () => {
    const dir = await tempDir("repo-instr-store-");
    const doc: RepoInstructionsDoc = {
      version: 1,
      content: "conventions",
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "edited",
      status: "ready",
    };
    await saveRepoInstructions(dir, REPO_KEY, doc);
    await expect(loadRepoInstructions(dir, REPO_KEY)).resolves.toEqual(doc);
  });

  it("returns null when missing", async () => {
    const dir = await tempDir("repo-instr-missing-");
    await expect(loadRepoInstructions(dir, REPO_KEY)).resolves.toBeNull();
  });
});

describe("seedRepoInstructions — CLAUDE.md present", () => {
  it("copies CLAUDE.md as source claude-md and never calls generate", async () => {
    const dir = await tempDir("repo-instr-md-");
    const repoPath = await repoWith("# Conventions\nUse pnpm.");
    const generate = vi.fn<() => Promise<string>>();
    await seedRepoInstructions({ dir, repoKey: REPO_KEY, repoPath, generate });
    const doc = await loadRepoInstructions(dir, REPO_KEY);
    expect(doc?.status).toBe("ready");
    expect(doc?.source).toBe("claude-md");
    expect(doc?.content).toBe("# Conventions\nUse pnpm.");
    expect(generate).not.toHaveBeenCalled();
    expect(isInstructionsGenerating(REPO_KEY)).toBe(false);
  });
});

describe("seedRepoInstructions — generation", () => {
  it("writes a generating placeholder, then lands ready/generated on resolve", async () => {
    const dir = await tempDir("repo-instr-gen-");
    const repoPath = await repoWith();
    const gen = deferred<string>();
    const settled = deferred<void>();
    const generate = vi.fn(() => gen.promise);
    await seedRepoInstructions({
      dir,
      repoKey: REPO_KEY,
      repoPath,
      generate,
      onSettled: () => settled.resolve(),
    });
    // Synchronous part done: placeholder written, generation in flight.
    expect(generate).toHaveBeenCalledOnce();
    expect(isInstructionsGenerating(REPO_KEY)).toBe(true);
    const placeholder = await loadRepoInstructions(dir, REPO_KEY);
    expect(placeholder?.status).toBe("generating");
    expect(placeholder?.content).toBe("");
    expect(placeholder?.generationStartedAt).toBeTruthy();

    gen.resolve("Generated conventions.");
    await settled.promise;
    const doc = await loadRepoInstructions(dir, REPO_KEY);
    expect(doc?.status).toBe("ready");
    expect(doc?.source).toBe("generated");
    expect(doc?.content).toBe("Generated conventions.");
    expect(isInstructionsGenerating(REPO_KEY)).toBe(false);
  });

  it("lands failed with the error message when generate rejects, never throwing", async () => {
    const dir = await tempDir("repo-instr-fail-");
    const repoPath = await repoWith();
    const settled = deferred<void>();
    const generate = vi.fn(async () => {
      throw new Error("no agent provider");
    });
    await expect(
      seedRepoInstructions({
        dir,
        repoKey: REPO_KEY,
        repoPath,
        generate,
        onSettled: () => settled.resolve(),
      }),
    ).resolves.toBeUndefined();
    await settled.promise;
    const doc = await loadRepoInstructions(dir, REPO_KEY);
    expect(doc?.status).toBe("failed");
    expect(doc?.error).toContain("no agent provider");
    expect(isInstructionsGenerating(REPO_KEY)).toBe(false);
  });

  it("a user edit during generation survives the resolve", async () => {
    const dir = await tempDir("repo-instr-editwin-");
    const repoPath = await repoWith();
    const gen = deferred<string>();
    const settled = deferred<void>();
    await seedRepoInstructions({
      dir,
      repoKey: REPO_KEY,
      repoPath,
      generate: () => gen.promise,
      onSettled: () => settled.resolve(),
    });
    // User edits mid-generation (clears generationStartedAt).
    await saveRepoInstructions(dir, REPO_KEY, {
      version: 1,
      content: "hand-written conventions",
      updatedAt: new Date().toISOString(),
      source: "edited",
      status: "ready",
    });
    gen.resolve("Generated conventions that must NOT overwrite the edit.");
    await settled.promise;
    const doc = await loadRepoInstructions(dir, REPO_KEY);
    expect(doc?.source).toBe("edited");
    expect(doc?.content).toBe("hand-written conventions");
  });
});

describe("seedRepoInstructions — force / existing doc", () => {
  it("leaves an existing ready doc untouched without force", async () => {
    const dir = await tempDir("repo-instr-keep-");
    const repoPath = await repoWith("fresh CLAUDE.md");
    await saveRepoInstructions(dir, REPO_KEY, {
      version: 1,
      content: "kept",
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "edited",
      status: "ready",
    });
    const generate = vi.fn<() => Promise<string>>();
    await seedRepoInstructions({ dir, repoKey: REPO_KEY, repoPath, generate });
    const doc = await loadRepoInstructions(dir, REPO_KEY);
    expect(doc?.content).toBe("kept");
    expect(generate).not.toHaveBeenCalled();
  });

  it("reseeds an existing ready doc when force is set", async () => {
    const dir = await tempDir("repo-instr-force-");
    const repoPath = await repoWith("regenerated from CLAUDE.md");
    await saveRepoInstructions(dir, REPO_KEY, {
      version: 1,
      content: "stale",
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "edited",
      status: "ready",
    });
    const generate = vi.fn<() => Promise<string>>();
    await seedRepoInstructions({ dir, repoKey: REPO_KEY, repoPath, generate, force: true });
    const doc = await loadRepoInstructions(dir, REPO_KEY);
    expect(doc?.source).toBe("claude-md");
    expect(doc?.content).toBe("regenerated from CLAUDE.md");
  });
});

describe("markStaleGenerations", () => {
  it("flips an on-disk generating doc to failed", async () => {
    const dir = await tempDir("repo-instr-stale-");
    await saveRepoInstructions(dir, REPO_KEY, {
      version: 1,
      content: "",
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "generated",
      status: "generating",
      generationStartedAt: "2026-07-24T00:00:00.000Z",
    });
    await markStaleGenerations(dir);
    const doc = await loadRepoInstructions(dir, REPO_KEY);
    expect(doc?.status).toBe("failed");
    expect(doc?.error).toContain("interrupted by app restart");
    expect(doc?.generationStartedAt).toBeUndefined();
  });

  it("leaves ready docs alone and tolerates a missing directory", async () => {
    const dir = await tempDir("repo-instr-stale2-");
    await saveRepoInstructions(dir, REPO_KEY, {
      version: 1,
      content: "ready",
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "edited",
      status: "ready",
    });
    await markStaleGenerations(dir);
    expect((await loadRepoInstructions(dir, REPO_KEY))?.status).toBe("ready");
    await expect(markStaleGenerations(join(dir, "does-not-exist"))).resolves.toBeUndefined();
  });
});

describe("readReadyInstructions", () => {
  it("returns content only for a ready non-blank doc", async () => {
    const dir = await tempDir("repo-instr-read-");
    await saveRepoInstructions(dir, REPO_KEY, {
      version: 1,
      content: "the conventions",
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "edited",
      status: "ready",
    });
    await expect(readReadyInstructions(dir, REPO_KEY)).resolves.toBe("the conventions");
  });

  it("returns undefined for generating / failed / blank docs and leaves no tmp files", async () => {
    const dir = await tempDir("repo-instr-read2-");
    await saveRepoInstructions(dir, REPO_KEY, {
      version: 1,
      content: "",
      updatedAt: "2026-07-24T00:00:00.000Z",
      source: "generated",
      status: "generating",
      generationStartedAt: "2026-07-24T00:00:00.000Z",
    });
    await expect(readReadyInstructions(dir, REPO_KEY)).resolves.toBeUndefined();
    const files = await readdir(dir);
    expect(files).toEqual(["acme_widgets.json"]);
  });
});
