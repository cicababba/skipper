import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    source: "github",
    sourceRef: { project: "o/r", key: String(n) },
    codeHost: "github",
    accountId: "acct-1",
    repo: { owner: "o", name: "r" },
    key: String(n),
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
      version: 2,
      settings: {
        intakePaused: false,
        autoPlanPaused: false,
        confidence: { high: 0.85, low: 0.4, extraPlanRuns: 2 },
        coderMaxTurns: 60,
        autoCoding: "auto",
        review: "auto",
        reviewMaxRounds: 2,
        shepherdRepush: "human",
        ciReentry: "off",
        codingWipPerRepo: 1,
      },
      items: {},
      parked: {},
      repoSettings: {},
      projectMappings: {},
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
    // #125: the role models are no longer backfilled — absent means inherit llm.claudeModel.
    expect(manifest.settings.plannerModel).toBeUndefined();
    expect(manifest.settings.confidence).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS.confidence);
    expect(manifest.settings.coderModel).toBeUndefined();
    expect(manifest.settings.coderMaxTurns).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.coderMaxTurns);
    expect(manifest.settings.autoCoding).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.autoCoding);
    expect(manifest.settings.review).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.review);
    expect(manifest.settings.reviewMaxRounds).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.reviewMaxRounds);
    expect(manifest.settings.reviewerModel).toBeUndefined();
    expect(manifest.settings.shepherdRepush).toBe("human");
    expect(manifest.settings.codingWipPerRepo).toBe(1);
    expect(manifest.repoSettings).toEqual({});
    expect(manifest.projectMappings).toEqual({});
  });

  it("backfills projectMappings and round-trips explicit ones (#79)", async () => {
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, settings: { intakePaused: false }, items: {}, parked: {} }),
      "utf-8",
    );
    const backfilled = await loadOrCreateOrchestratorManifest(filePath);
    expect(backfilled.projectMappings).toEqual({});

    backfilled.projectMappings["jira:acme.atlassian.net:PROJ"] = "octo/demo";
    await saveOrchestratorManifest(filePath, backfilled);
    const loaded = await loadOrCreateOrchestratorManifest(filePath);
    expect(loaded.projectMappings).toEqual({ "jira:acme.atlassian.net:PROJ": "octo/demo" });
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
    expect(manifest.version).toBe(2);
    expect(manifest.items).toEqual({});
  });

  it("returns a fresh manifest on version mismatch", async () => {
    await writeFile(filePath, JSON.stringify({ version: 3, items: { x: {} } }), "utf-8");
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.version).toBe(2);
    expect(manifest.items).toEqual({});
  });

  // #125: v1 manifests carried a materialized opus trio; the strip lets absent keys
  // fall through to llm.claudeModel, while a deliberately non-opus role survives.
  describe("role model inherit migration (#125)", () => {
    it("strips the materialized opus trio from a v1 manifest, keeping non-opus roles", async () => {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          settings: {
            intakePaused: false,
            plannerModel: "opus",
            coderModel: "opus",
            reviewerModel: "haiku",
          },
          items: {},
          parked: {},
        }),
        "utf-8",
      );
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.version).toBe(2);
      expect(manifest.settings.plannerModel).toBeUndefined();
      expect(manifest.settings.coderModel).toBeUndefined();
      expect(manifest.settings.reviewerModel).toBe("haiku");
    });

    it("keeps an explicit opus chosen on a v2 manifest un-stripped across reloads", async () => {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 2,
          settings: { intakePaused: false, plannerModel: "opus" },
          items: {},
          parked: {},
        }),
        "utf-8",
      );
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.version).toBe(2);
      expect(manifest.settings.plannerModel).toBe("opus");

      await saveOrchestratorManifest(filePath, manifest);
      const reloaded = await loadOrCreateOrchestratorManifest(filePath);
      expect(reloaded.settings.plannerModel).toBe("opus");
    });
  });

  it("migrates pre-#71 items: platform → source + codeHost, key from number", async () => {
    const legacyItem = {
      id: "github:1234567890",
      platform: "github",
      accountId: "acct-1",
      repo: { owner: "o", name: "r" },
      number: 42,
      title: "Issue 42",
      url: "https://github.com/o/r/issues/42",
      state: "coding",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      transitions: [],
      worktree: { path: "/w/o-r/issue-42", branch: "feature/issue-42" },
    };
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        settings: { intakePaused: false },
        items: { "github:1234567890": legacyItem },
        parked: {},
      }),
      "utf-8",
    );

    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    const item = manifest.items["github:1234567890"];
    expect(item.source).toBe("github");
    expect(item.codeHost).toBe("github");
    expect(item.key).toBe("42");
    expect(item.sourceRef).toEqual({ project: "o/r", key: "42" });
    expect(item.number).toBe(42);
    expect(item.worktree).toEqual({ path: "/w/o-r/issue-42", branch: "feature/issue-42" });
    expect("platform" in item).toBe(false);

    // The migrated shape reserializes without the legacy key.
    await saveOrchestratorManifest(filePath, manifest);
    const raw = JSON.parse(await readFile(filePath, "utf-8")) as OrchestratorManifest;
    expect("platform" in raw.items["github:1234567890"]).toBe(false);
    expect(raw.items["github:1234567890"].key).toBe("42");
  });

  describe("account-key resolution (#101)", () => {
    async function writeWithItem(accountId: string): Promise<void> {
      const item = { ...admitItem(issue(1)), accountId };
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          settings: { intakePaused: false },
          items: { [item.id]: item },
          parked: {},
        }),
        "utf-8",
      );
    }

    it("rewrites a bare native id to the unique matching account's key", async () => {
      await writeWithItem("42");
      const manifest = await loadOrCreateOrchestratorManifest(filePath, [
        { id: "42", key: "gitlab:git.corp:42" },
      ]);
      expect(manifest.items["github:1"].accountId).toBe("gitlab:git.corp:42");
    });

    it("keeps an accountId that is already a known key", async () => {
      await writeWithItem("gitlab:git.corp:42");
      const manifest = await loadOrCreateOrchestratorManifest(filePath, [
        { id: "42", key: "gitlab:git.corp:42" },
      ]);
      expect(manifest.items["github:1"].accountId).toBe("gitlab:git.corp:42");
    });

    it("drops an item whose account is unknown", async () => {
      await writeWithItem("999");
      const warn = vi.fn();
      const manifest = await loadOrCreateOrchestratorManifest(
        filePath,
        [{ id: "42", key: "gitlab:42" }],
        warn,
      );
      expect(manifest.items["github:1"]).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    });

    it("drops an item whose native id is ambiguous across hosts", async () => {
      await writeWithItem("42");
      const warn = vi.fn();
      const manifest = await loadOrCreateOrchestratorManifest(
        filePath,
        [
          { id: "42", key: "gitlab:42" },
          { id: "42", key: "gitlab:git.corp:42" },
        ],
        warn,
      );
      expect(manifest.items["github:1"]).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    });

    it("leaves items untouched when no accounts are supplied", async () => {
      await writeWithItem("42");
      const noArg = await loadOrCreateOrchestratorManifest(filePath);
      expect(noArg.items["github:1"].accountId).toBe("42");
      await writeWithItem("42");
      const empty = await loadOrCreateOrchestratorManifest(filePath, []);
      expect(empty.items["github:1"].accountId).toBe("42");
    });
  });

  it("serializes concurrent saves — last write wins and the file stays valid", async () => {
    const base: OrchestratorManifest = {
      version: 2,
      settings: structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS),
      items: {},
      parked: {},
      repoSettings: {},
      projectMappings: {},
    };
    const saves = Array.from({ length: 10 }, (_, i) =>
      saveOrchestratorManifest(filePath, {
        ...base,
        parked: { [`github:${i}`]: { firstSeenAt: `2026-07-11T10:00:0${i % 10}.000Z` } },
      }),
    );
    await Promise.all(saves);

    const raw = JSON.parse(await readFile(filePath, "utf-8")) as OrchestratorManifest;
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.parked)).toEqual(["github:9"]);
  });
});
