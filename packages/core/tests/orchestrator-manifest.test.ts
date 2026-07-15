import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateOrchestratorManifest,
  saveOrchestratorManifest,
  admitItem,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  type OrchestratorManifest,
} from "../src/orchestrator";
import type { Issue } from "@skipper/shared";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-orch-"));
  filePath = join(dir, "orchestrator-manifest.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function issue(n: number): Issue {
  return {
    id: `github:${n}`,
    kind: "issue",
    platform: "github",
    accountId: "acct-1",
    repo: { owner: "o", name: "r" },
    number: n,
    title: `Issue ${n}`,
    labels: [],
    assignees: [],
    url: `https://github.com/o/r/issues/${n}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
  };
}

describe("orchestrator manifest", () => {
  it("returns a fresh manifest when the file is missing", async () => {
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest).toEqual({
      version: 1,
      settings: {
        intakePaused: false,
        autoPlanPaused: false,
        plannerModel: "opus",
        confidence: { high: 0.85, low: 0.4, extraPlanRuns: 2 },
        coderModel: "opus",
        coderMaxTurns: 60,
        autoCoding: "auto",
        review: "auto",
        reviewMaxRounds: 2,
        reviewerModel: "opus",
        shepherdRepush: "human",
        ciReentry: "off",
        codingWipPerRepo: 1,
      },
      items: {},
      parked: {},
      repoSettings: {},
    });
  });

  it("fills #8/#9/#10/#11/#62 settings defaults into an older manifest", async () => {
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, settings: { intakePaused: true }, items: {}, parked: {} }),
      "utf-8",
    );
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.settings.intakePaused).toBe(true);
    expect(manifest.settings.autoPlanPaused).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.autoPlanPaused);
    expect(manifest.settings.plannerModel).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.plannerModel);
    expect(manifest.settings.confidence).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS.confidence);
    expect(manifest.settings.coderModel).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.coderModel);
    expect(manifest.settings.coderMaxTurns).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.coderMaxTurns);
    expect(manifest.settings.autoCoding).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.autoCoding);
    expect(manifest.settings.review).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.review);
    expect(manifest.settings.reviewMaxRounds).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.reviewMaxRounds);
    expect(manifest.settings.reviewerModel).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.reviewerModel);
    expect(manifest.settings.shepherdRepush).toBe("human");
    expect(manifest.settings.codingWipPerRepo).toBe(1);
    expect(manifest.repoSettings).toEqual({});
  });

  // #62. reviewMode was hand-edit-only but read for real, so a hand-set value must
  // survive the rename — a plain ??= would silently reset "always" to "auto",
  // i.e. quietly give the user less review than they asked for.
  describe("reviewMode → review migration (#62)", () => {
    const write = (settings: Record<string, unknown>) =>
      writeFile(
        filePath,
        JSON.stringify({ version: 1, settings, items: {}, parked: {} }),
        "utf-8",
      );

    it.each([
      ["always", "on"],
      ["never", "off"],
      ["auto", "auto"],
    ])("maps a legacy reviewMode %s to review %s", async (legacy, expected) => {
      await write({ intakePaused: false, reviewMode: legacy });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.settings.review).toBe(expected);
    });

    it("consumes the legacy key so it cannot mislead a later hand-edit", async () => {
      await write({ intakePaused: false, reviewMode: "never" });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect("reviewMode" in manifest.settings).toBe(false);

      await saveOrchestratorManifest(filePath, manifest);
      const raw = JSON.parse(await readFile(filePath, "utf-8")) as {
        settings: Record<string, unknown>;
      };
      expect("reviewMode" in raw.settings).toBe(false);
      expect(raw.settings.review).toBe("off");
    });

    it("defaults to auto when neither key is present", async () => {
      await write({ intakePaused: false });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.settings.review).toBe("auto");
    });

    it("lets the new field win when both are present", async () => {
      await write({ intakePaused: false, review: "off", reviewMode: "always" });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.settings.review).toBe("off");
      expect("reviewMode" in manifest.settings).toBe(false);
    });
  });

  it("keeps explicit #15 fields on an existing manifest", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        settings: { intakePaused: false, codingWipPerRepo: 3 },
        items: {},
        parked: {},
        repoSettings: { "o/r": { followed: false, priority: "high" } },
        resumeRite: { itemIds: ["github:1"], createdAt: "2026-07-12T00:00:00.000Z" },
      }),
      "utf-8",
    );
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.settings.codingWipPerRepo).toBe(3);
    expect(manifest.repoSettings["o/r"]).toEqual({ followed: false, priority: "high" });
    expect(manifest.resumeRite).toEqual({
      itemIds: ["github:1"],
      createdAt: "2026-07-12T00:00:00.000Z",
    });
  });

  it("keeps an explicit shepherdRepush value", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        settings: { intakePaused: false, shepherdRepush: "auto" },
        items: {},
        parked: {},
      }),
      "utf-8",
    );
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.settings.shepherdRepush).toBe("auto");
  });

  it("round-trips items, settings and parked entries", async () => {
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    const item = admitItem(issue(7));
    manifest.items[item.id] = item;
    manifest.settings.intakePaused = true;
    manifest.parked["github:8"] = { firstSeenAt: "2026-07-11T10:00:00.000Z" };
    await saveOrchestratorManifest(filePath, manifest);

    const loaded = await loadOrCreateOrchestratorManifest(filePath);
    expect(loaded).toEqual(manifest);
  });

  it("returns a fresh manifest on corrupt JSON", async () => {
    await writeFile(filePath, "{ not json", "utf-8");
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.version).toBe(1);
    expect(manifest.items).toEqual({});
  });

  it("returns a fresh manifest on version mismatch", async () => {
    await writeFile(filePath, JSON.stringify({ version: 2, items: { x: {} } }), "utf-8");
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.version).toBe(1);
    expect(manifest.items).toEqual({});
  });

  it("serializes concurrent saves — last write wins and the file stays valid", async () => {
    const base: OrchestratorManifest = {
      version: 1,
      settings: structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS),
      items: {},
      parked: {},
      repoSettings: {},
    };
    const saves = Array.from({ length: 10 }, (_, i) =>
      saveOrchestratorManifest(filePath, {
        ...base,
        parked: { [`github:${i}`]: { firstSeenAt: `2026-07-11T10:00:0${i % 10}.000Z` } },
      }),
    );
    await Promise.all(saves);

    const raw = JSON.parse(await readFile(filePath, "utf-8")) as OrchestratorManifest;
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.parked)).toEqual(["github:9"]);
  });
});
