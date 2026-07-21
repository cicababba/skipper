import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfidenceReport, StoredPlan } from "@skipper/shared";
import {
  archiveStoredPlan,
  readStoredPlan,
  updateStoredPlan,
  writeStoredPlan,
} from "./plan-store";

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

describe("updateStoredPlan (#165)", () => {
  const ref = "github_1.json";

  it("snapshots the superseded body with the given source at editedAt", async () => {
    const original = makePlan("github:1");
    await writeStoredPlan(dir, ref, original);

    const updated = await updateStoredPlan(
      dir,
      ref,
      { ...original.plan, summary: "edited" },
      "inline-edit",
    );
    expect(updated?.plan.summary).toBe("edited");
    expect(updated?.revisions).toHaveLength(1);
    const rev = updated!.revisions![0];
    expect(rev.plan).toEqual(original.plan);
    expect(rev.source).toBe("inline-edit");
    expect(rev.at).toBe(updated!.editedAt);
  });

  it("accumulates revisions oldest-first across updates", async () => {
    const original = makePlan("github:1");
    await writeStoredPlan(dir, ref, original);

    await updateStoredPlan(dir, ref, { ...original.plan, summary: "v2" }, "inline-edit");
    const second = await updateStoredPlan(dir, ref, { ...original.plan, summary: "v3" }, "chat-apply");

    expect(second?.revisions).toHaveLength(2);
    expect(second!.revisions![0].plan.summary).toBe("s");
    expect(second!.revisions![0].source).toBe("inline-edit");
    expect(second!.revisions![1].plan.summary).toBe("v2");
    expect(second!.revisions![1].source).toBe("chat-apply");
    expect(await readStoredPlan(dir, ref)).toEqual(second);
  });

  it("preserves the rest of the envelope", async () => {
    const original = makePlan("github:1");
    await writeStoredPlan(dir, ref, original);

    const updated = await updateStoredPlan(
      dir,
      ref,
      { ...original.plan, summary: "edited" },
      "inline-edit",
    );
    expect(updated?.generatedAt).toBe(original.generatedAt);
    expect(updated?.model).toBe(original.model);
    expect(updated?.version).toBe(2);
  });

  it("snapshots the confidence at supersede time (#169)", async () => {
    const original = makePlan("github:1");
    original.confidence = { composite: 0.7 } as unknown as ConfidenceReport;
    await writeStoredPlan(dir, ref, original);

    const updated = await updateStoredPlan(
      dir,
      ref,
      { ...original.plan, summary: "edited" },
      "inline-edit",
    );
    expect(updated?.revisions?.[0].confidence).toEqual({ composite: 0.7 });
  });

  it("leaves the revision confidence undefined when the plan had none (#169)", async () => {
    const original = makePlan("github:1");
    await writeStoredPlan(dir, ref, original);
    const updated = await updateStoredPlan(dir, ref, { ...original.plan, summary: "edited" }, "chat-apply");
    expect(updated?.revisions?.[0].confidence).toBeUndefined();
  });

  it("starts a one-element array on a legacy file without revisions", async () => {
    const original = makePlan("github:1");
    await writeStoredPlan(dir, ref, original);
    expect(original.revisions).toBeUndefined();

    const updated = await updateStoredPlan(
      dir,
      ref,
      { ...original.plan, summary: "edited" },
      "chat-apply",
    );
    expect(updated?.revisions).toHaveLength(1);
  });
});
