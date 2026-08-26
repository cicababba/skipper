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
      version: 3,
      settings: {
        intakePaused: false,
        autoPlanPaused: false,
        confidence: { high: 0.74, low: 0.49, extraPlanRuns: 2 },
        coderTimeBudgetMin: 60,
        plannerTimeBudgetMin: 15,
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
    // The role pairs are never backfilled — absent means inherit defaultAgent.
    expect(manifest.settings.plannerAgent).toBeUndefined();
    expect(manifest.settings.confidence).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS.confidence);
    expect(manifest.settings.coderAgent).toBeUndefined();
    expect(manifest.settings.coderTimeBudgetMin).toBe(
      DEFAULT_ORCHESTRATOR_SETTINGS.coderTimeBudgetMin,
    );
    expect(manifest.settings.plannerTimeBudgetMin).toBe(
      DEFAULT_ORCHESTRATOR_SETTINGS.plannerTimeBudgetMin,
    );
    expect(manifest.settings.autoCoding).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.autoCoding);
    expect(manifest.settings.review).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.review);
    expect(manifest.settings.reviewMaxRounds).toBe(DEFAULT_ORCHESTRATOR_SETTINGS.reviewMaxRounds);
    expect(manifest.settings.reviewerAgent).toBeUndefined();
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

  // #194. The agent-turn knobs became wall-clock budgets; the old values do not
  // convert (pre-beta) — they are consumed and dropped, and the new keys default in.
  describe("turn knobs → time budgets migration (#194)", () => {
    const write = (settings: Record<string, unknown>) =>
      writeFile(filePath, JSON.stringify({ version: 1, settings, items: {}, parked: {} }), "utf-8");

    it("drops legacy coderMaxTurns/plannerMaxTurns and backfills the time budgets", async () => {
      await write({ intakePaused: false, coderMaxTurns: 80, plannerMaxTurns: 30 });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect("coderMaxTurns" in manifest.settings).toBe(false);
      expect("plannerMaxTurns" in manifest.settings).toBe(false);
      expect(manifest.settings.coderTimeBudgetMin).toBe(
        DEFAULT_ORCHESTRATOR_SETTINGS.coderTimeBudgetMin,
      );
      expect(manifest.settings.plannerTimeBudgetMin).toBe(
        DEFAULT_ORCHESTRATOR_SETTINGS.plannerTimeBudgetMin,
      );

      await saveOrchestratorManifest(filePath, manifest);
      const raw = JSON.parse(await readFile(filePath, "utf-8")) as {
        settings: Record<string, unknown>;
      };
      expect("coderMaxTurns" in raw.settings).toBe(false);
      expect("plannerMaxTurns" in raw.settings).toBe(false);
    });

    it("preserves an explicit time budget already on the manifest", async () => {
      await write({ intakePaused: false, coderTimeBudgetMin: 120, plannerTimeBudgetMin: 45 });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.settings.coderTimeBudgetMin).toBe(120);
      expect(manifest.settings.plannerTimeBudgetMin).toBe(45);
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
    expect(manifest.version).toBe(3);
    expect(manifest.items).toEqual({});
  });

  it("returns a fresh manifest on version mismatch", async () => {
    await writeFile(filePath, JSON.stringify({ version: 4, items: { x: {} } }), "utf-8");
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.version).toBe(3);
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
      expect(manifest.version).toBe(3);
      // The stripped roles carry no pair at all — absent is how "inherit" is spelled.
      expect(manifest.settings.plannerAgent).toBeUndefined();
      expect(manifest.settings.coderAgent).toBeUndefined();
      expect(manifest.settings.reviewerAgent).toEqual({ runtime: "claude-cli", model: "haiku" });
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
      expect(manifest.version).toBe(3);
      expect(manifest.settings.plannerAgent).toEqual({ runtime: "claude-cli", model: "opus" });

      await saveOrchestratorManifest(filePath, manifest);
      const reloaded = await loadOrCreateOrchestratorManifest(filePath);
      expect(reloaded.settings.plannerAgent).toEqual({ runtime: "claude-cli", model: "opus" });
    });
  });

  // v2 → v3: the flat model/runtime keys become atomic pairs. The legacy model
  // rides along only onto a claude pair — legacy models were Claude aliases, so
  // carrying one onto a codex pair would inject a bogus `--model opus`.
  describe("agent pair migration (v2 → v3)", () => {
    const writeV2 = (settings: Record<string, unknown>, repoSettings: Record<string, unknown> = {}) =>
      writeFile(
        filePath,
        JSON.stringify({ version: 2, settings, items: {}, parked: {}, repoSettings }),
        "utf-8",
      );

    it("pairs a legacy claude runtime with its model", async () => {
      await writeV2({ intakePaused: false, coderRuntime: "claude-cli", coderModel: "opus" });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.version).toBe(3);
      expect(manifest.settings.coderAgent).toEqual({ runtime: "claude-cli", model: "opus" });
    });

    it("defaults a model-only legacy role to the claude runtime", async () => {
      await writeV2({ intakePaused: false, plannerModel: "haiku" });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.settings.plannerAgent).toEqual({ runtime: "claude-cli", model: "haiku" });
    });

    it("drops the legacy model when the pair lands on a non-claude runtime", async () => {
      await writeV2({ intakePaused: false, coderRuntime: "codex-cli", coderModel: "opus" });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.settings.coderAgent).toEqual({ runtime: "codex-cli" });
    });

    it("leaves a role with neither legacy key without a pair", async () => {
      await writeV2({ intakePaused: false, coderRuntime: "gemini-cli" });
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.settings.coderAgent).toEqual({ runtime: "gemini-cli" });
      expect(manifest.settings.plannerAgent).toBeUndefined();
      expect(manifest.settings.reviewerAgent).toBeUndefined();
      expect(manifest.settings.defaultAgent).toBeUndefined();
    });

    it("migrates every repoSettings entry too", async () => {
      await writeV2(
        { intakePaused: false },
        {
          "o/r": { followed: true, coderRuntime: "codex-cli", coderModel: "opus" },
          "o/s": { plannerModel: "sonnet" },
        },
      );
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.repoSettings["o/r"]).toEqual({
        followed: true,
        coderAgent: { runtime: "codex-cli" },
      });
      expect(manifest.repoSettings["o/s"]).toEqual({
        plannerAgent: { runtime: "claude-cli", model: "sonnet" },
      });
    });

    it("consumes the legacy keys so they cannot mislead a later hand-edit", async () => {
      await writeV2(
        { intakePaused: false, coderRuntime: "codex-cli", coderModel: "opus" },
        { "o/r": { plannerRuntime: "gemini-cli", plannerModel: "opus" } },
      );
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      await saveOrchestratorManifest(filePath, manifest);
      const raw = JSON.parse(await readFile(filePath, "utf-8")) as {
        settings: Record<string, unknown>;
        repoSettings: Record<string, Record<string, unknown>>;
      };
      expect("coderRuntime" in raw.settings).toBe(false);
      expect("coderModel" in raw.settings).toBe(false);
      expect("plannerRuntime" in raw.repoSettings["o/r"]).toBe(false);
      expect("plannerModel" in raw.repoSettings["o/r"]).toBe(false);
    });

    it("never re-runs on a v3 manifest", async () => {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 3,
          settings: { intakePaused: false, coderAgent: { runtime: "gemini-cli" } },
          items: {},
          parked: {},
          repoSettings: {},
        }),
        "utf-8",
      );
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.version).toBe(3);
      expect(manifest.settings.coderAgent).toEqual({ runtime: "gemini-cli" });

      await saveOrchestratorManifest(filePath, manifest);
      const reloaded = await loadOrCreateOrchestratorManifest(filePath);
      expect(reloaded.settings.coderAgent).toEqual({ runtime: "gemini-cli" });
    });

    // A v1 manifest walks the whole chain: the opus strip runs first, then the pairs.
    it("carries a v1 manifest through both steps to v3", async () => {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          settings: {
            intakePaused: false,
            coderModel: "opus",
            reviewerModel: "haiku",
            reviewerRuntime: "copilot-cli",
          },
          items: {},
          parked: {},
        }),
        "utf-8",
      );
      const manifest = await loadOrCreateOrchestratorManifest(filePath);
      expect(manifest.version).toBe(3);
      // The materialized opus was stripped before pairing, so the coder has no pair.
      expect(manifest.settings.coderAgent).toBeUndefined();
      expect(manifest.settings.reviewerAgent).toEqual({ runtime: "copilot-cli" });
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
      version: 3,
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
    expect(raw.version).toBe(3);
    expect(Object.keys(raw.parked)).toEqual(["github:9"]);
  });
});
