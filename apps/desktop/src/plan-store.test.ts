import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredPlan } from "@skipper/shared";
import { archiveStoredPlan, readStoredPlan, writeStoredPlan } from "./plan-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-plan-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makePlan(itemId: string): StoredPlan {
  return {
    version: 2,
    itemId,
    repo: { owner: "octo", name: "repo" },
    generatedAt: "2026-07-20T00:00:00.000Z",
    model: "claude",
    plan: {
      summary: "s",
      files: [],
      steps: [],
      acceptance: [],
      risks: [],
      openQuestions: [],
      estimatedSize: "s",
    },
  };
}

describe("archiveStoredPlan (#115)", () => {
  it("moves the plan under archive/ and round-trips through readStoredPlan", async () => {
    const ref = "github_1.json";
    await writeStoredPlan(dir, ref, makePlan("github:1"));

    const archivedRef = await archiveStoredPlan(dir, ref);
    expect(archivedRef).toBe("archive/github_1.json");

    const stored = await readStoredPlan(dir, archivedRef!);
    expect(stored?.itemId).toBe("github:1");
    expect(await readStoredPlan(dir, ref)).toBeNull();
  });

  it("returns an already-archived ref unchanged", async () => {
    expect(await archiveStoredPlan(dir, "archive/github_1.json")).toBe("archive/github_1.json");
  });

  it("returns the archive ref when the source is gone but the target exists", async () => {
    await mkdir(join(dir, "archive"), { recursive: true });
    await writeFile(join(dir, "archive", "github_1.json"), "{}", "utf-8");
    expect(await archiveStoredPlan(dir, "github_1.json")).toBe("archive/github_1.json");
  });

  it("returns null when both source and target are missing", async () => {
    expect(await archiveStoredPlan(dir, "github_1.json")).toBeNull();
  });
});
