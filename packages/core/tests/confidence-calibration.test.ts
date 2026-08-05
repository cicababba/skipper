import { describe, it, expect } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  type ClaritySignal,
  type ConfidenceWeights,
  type CriticSignal,
  type OrchestratorSettings,
} from "@skipper/shared";
import {
  DEFAULT_CONFIDENCE_WEIGHTS,
  buildCalibrationRows,
  compositeOf,
  computeConfidence,
  findIncompleteSamples,
  missingSignals,
  porcelainPaths,
  renderCalibrationReport,
  renderIncompleteWarning,
  overridePlannerPair,
  renderPlannerPairBanner,
  replayScores,
  resolvePlannerPair,
  summarizePlannerPairs,
  sweepThresholds,
  worktreeDirtyError,
  type CalibrationLabel,
  type CalibrationMeta,
  type CalibrationSample,
  type PlannerPair,
} from "../src/confidence";
import type { IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface } from "../src/llm/provider";
import type { PlanIssueInput } from "../src/planner";

const CLARITY: ClaritySignal = {
  score: 0.8,
  criteria: "verifiable",
  ambiguities: [{ detail: "which default", resolvableFromRepo: false, flaggedByPlan: true }],
  openQuestions: [{ question: "which default?", kind: "issue-ambiguity" }],
  rationale: "checkable outcomes, one open decision the plan flags",
};

const CRITIC: CriticSignal = {
  score: 0.94,
  verdict: "concerns",
  objections: [{ kind: "underspecified", detail: "no rollback path", blocking: false }],
};

function sample(over: Partial<CalibrationSample> = {}): CalibrationSample {
  return {
    version: 1,
    id: "s1",
    repo: "cicababba/todos",
    provenance: "authored:calibration",
    issueKey: "ISSUE-1",
    issueTitle: "show how many todos are left",
    issueUrl: "https://example.com/todos/1",
    plan: {
      summary: "Render a remaining-todos counter",
      fileCount: 1,
      stepCount: 2,
      estimatedSize: "s",
      openQuestions: [],
    },
    signals: {
      groundedness: {
        score: 1,
        coverage: 1,
        filesChecked: 1,
        filesFound: 1,
        symbolsChecked: 1,
        symbolsFound: 1,
        missingFiles: [],
        missingSymbols: [],
        newFiles: [],
      },
      convergence: {
        score: 0.9,
        planCount: 3,
        fileJaccard: 0.9,
        sizeAgreement: 1,
        stepCountAgreement: 0.8,
        divergent: false,
        sharedFiles: ["web/src/TodoList.tsx"],
        disputedFiles: [],
      },
      clarity: CLARITY,
      critic: CRITIC,
    },
    composite: 0,
    weights: DEFAULT_CONFIDENCE_WEIGHTS,
    runtime: "claude-cli",
    model: "sonnet",
    graphify: false,
    timings: { planMs: 1, extraPlansMs: 1, scoringMs: 1, totalMs: 3 },
    errors: [],
    collectedAt: "2026-08-04T10:00:00.000Z",
    ...over,
  };
}

const META: CalibrationMeta = {
  runId: "run-1",
  runtime: "claude-cli",
  model: "sonnet",
  graphify: false,
  weights: DEFAULT_CONFIDENCE_WEIGHTS,
  generatedAt: "2026-08-04T10:00:00.000Z",
};

describe("replayScores", () => {
  it("reproduces the stored scores when the derivations are unchanged", () => {
    const { scores, fallbacks } = replayScores(sample());
    expect(scores.groundedness).toBe(1);
    expect(scores.convergence).toBe(0.9);
    // verifiable 1.0 − 0.05 flagged − 0 repo-knowledge
    expect(scores.clarity).toBeCloseTo(0.95, 10);
    expect(scores.critic).toBeCloseTo(0.94, 10);
    expect(fallbacks).toEqual([]);
  });

  it("re-derives from the raw judgment instead of trusting a stale stored score", () => {
    const stale = sample({
      signals: {
        ...sample().signals,
        clarity: { ...CLARITY, score: 0.11 },
        critic: { ...CRITIC, score: 0.11 },
      },
    });
    const { scores, fallbacks } = replayScores(stale);
    expect(scores.clarity).toBeCloseTo(0.95, 10);
    expect(scores.critic).toBeCloseTo(0.94, 10);
    expect(fallbacks).toEqual([]);
  });

  it("picks up an alternate derivation, which is what makes the corpus reusable", () => {
    const { scores } = replayScores(sample(), {
      deriveClarity: (j) => (j.criteria === "verifiable" ? 0.42 : 0),
      deriveCritic: (verdict) => (verdict === "concerns" ? 0.33 : 0),
    });
    expect(scores.clarity).toBe(0.42);
    expect(scores.critic).toBe(0.33);
  });

  it("falls back to the stored score when the raw judgment is absent, and flags it", () => {
    const legacy = sample({
      signals: {
        ...sample().signals,
        clarity: { score: 0.4, bodyPresent: true, hasAcceptanceCriteria: false },
        critic: { score: 0.7 } as CriticSignal,
      },
    });
    const { scores, fallbacks } = replayScores(legacy);
    expect(scores.clarity).toBe(0.4);
    expect(scores.critic).toBe(0.7);
    expect(fallbacks.sort()).toEqual(["clarity", "critic"]);
  });

  it("leaves an absent signal absent", () => {
    const partial = sample({ signals: { clarity: CLARITY } });
    const { scores } = replayScores(partial);
    expect(scores.groundedness).toBeUndefined();
    expect(scores.convergence).toBeUndefined();
    expect(scores.critic).toBeUndefined();
  });
});

describe("compositeOf", () => {
  const W: ConfidenceWeights = DEFAULT_CONFIDENCE_WEIGHTS;

  it("is the plain weighted sum when all four signals are present", () => {
    const scores = { groundedness: 1, critic: 0.6, convergence: 0.9, clarity: 0.95 };
    const expected =
      1 * W.groundedness + 0.6 * W.critic + 0.9 * W.convergence + 0.95 * W.clarity;
    expect(compositeOf(scores, W)).toBeCloseTo(expected, 10);
  });

  it("renormalizes over the weights of the signals present", () => {
    const scores = { groundedness: 1, critic: 0.6, clarity: 0.95 };
    const total = W.groundedness + W.critic + W.clarity;
    const expected = (1 * W.groundedness + 0.6 * W.critic + 0.95 * W.clarity) / total;
    expect(compositeOf(scores, W)).toBeCloseTo(expected, 10);
  });

  it("is 0 when no signal is present", () => {
    expect(compositeOf({}, W)).toBe(0);
  });

  it("matches computeConfidence's composite for the same signals", async () => {
    const plan: IssuePlan = {
      summary: "s",
      files: [],
      steps: [],
      acceptance: [],
      risks: [],
      openQuestions: [],
      estimatedSize: "s",
    };
    const issue: PlanIssueInput = { key: "1", title: "t", url: "u", labels: [] };
    const llm = {
      name: "fake",
      askStructured: async (_p: string, schema: Record<string, unknown>) =>
        String(JSON.stringify(schema)).includes("criteria")
          ? {
              criteria: "verifiable",
              ambiguities: [{ detail: "d", resolvableFromRepo: false, flaggedByPlan: true }],
              openQuestions: [{ question: "q", kind: "issue-ambiguity" }],
              rationale: "r",
            }
          : {
              verdict: "concerns",
              objections: [{ kind: "underspecified", detail: "d", blocking: false }],
            },
    } as unknown as LLMProviderInterface;

    const report = await computeConfidence({
      plan,
      issue,
      repoPath: process.cwd(),
      llm,
      extraPlanRuns: 0,
    });
    const scores = {
      groundedness: report.signals.groundedness!.score,
      critic: report.signals.critic!.score,
      clarity: report.signals.clarity!.score,
    };
    expect(compositeOf(scores, DEFAULT_CONFIDENCE_WEIGHTS)).toBeCloseTo(report.composite, 10);
  });
});

function rowsFrom(entries: { id: string; composite: number; label: CalibrationLabel }[]) {
  const samples = entries.map((e) =>
    sample({
      id: e.id,
      signals: {
        groundedness: {
          score: e.composite,
          coverage: 1,
          filesChecked: 0,
          filesFound: 0,
          symbolsChecked: 0,
          symbolsFound: 0,
          missingFiles: [],
          missingSymbols: [],
          newFiles: [],
        },
      },
    }),
  );
  const labels = Object.fromEntries(entries.map((e) => [e.id, e.label]));
  return buildCalibrationRows(samples, labels, DEFAULT_CONFIDENCE_WEIGHTS);
}

describe("sweepThresholds", () => {
  it("finds the separating range on cleanly separated labels", () => {
    const rows = rowsFrom([
      { id: "a", composite: 0.9, label: "approve-unread" },
      { id: "b", composite: 0.88, label: "approve-unread" },
      { id: "c", composite: 0.7, label: "wants-to-read" },
      { id: "d", composite: 0.65, label: "wants-to-read" },
    ]);
    const { high } = sweepThresholds(rows);
    expect(high.positives).toBe(2);
    expect(high.negatives).toBe(2);
    expect(high.margin).toBeCloseTo(0.18, 10);
    expect(high.separating).toEqual({ min: 0.71, max: 0.88 });
  });

  it("reports a non-positive margin and no separating range when labels interleave", () => {
    const rows = rowsFrom([
      { id: "a", composite: 0.9, label: "approve-unread" },
      { id: "b", composite: 0.6, label: "approve-unread" },
      { id: "c", composite: 0.8, label: "wants-to-read" },
    ]);
    const { high } = sweepThresholds(rows);
    expect(high.margin).toBeLessThanOrEqual(0);
    expect(high.separating).toBeUndefined();
  });

  it("mirrors the shape for the low band against not-plannable", () => {
    const rows = rowsFrom([
      { id: "a", composite: 0.9, label: "approve-unread" },
      { id: "b", composite: 0.7, label: "wants-to-read" },
      { id: "c", composite: 0.55, label: "not-plannable" },
    ]);
    const { low } = sweepThresholds(rows);
    expect(low.positives).toBe(2);
    expect(low.negatives).toBe(1);
    expect(low.margin).toBeCloseTo(0.15, 10);
    expect(low.separating).toEqual({ min: 0.56, max: 0.7 });
  });

  it("handles a single-row corpus without crashing", () => {
    const rows = rowsFrom([{ id: "a", composite: 0.9, label: "approve-unread" }]);
    const { high, low } = sweepThresholds(rows);
    expect(high.negatives).toBe(0);
    expect(high.margin).toBeUndefined();
    expect(low.positives).toBe(1);
    expect(high.candidates.length).toBeGreaterThan(0);
  });

  it("excludes vetoed and unlabeled rows from the decision", () => {
    const vetoed = sample({
      id: "v",
      veto: { signal: "groundedness", detail: "3 cited files are absent" },
    });
    const unlabeled = sample({ id: "u" });
    const rows = buildCalibrationRows(
      [vetoed, unlabeled],
      { v: "approve-unread" },
      DEFAULT_CONFIDENCE_WEIGHTS,
    );
    const sweep = sweepThresholds(rows);
    expect(sweep.excluded.vetoed).toEqual(["v"]);
    expect(sweep.excluded.unlabeled).toEqual(["u"]);
    expect(sweep.high.positives).toBe(0);
  });
});

describe("porcelainPaths", () => {
  it("reads modified, untracked and renamed entries", () => {
    const stdout = [" M apps/web/src/App.tsx", "?? scratch.txt", 'R  old.ts -> new.ts', ""].join("\n");
    expect(porcelainPaths(stdout)).toEqual(["apps/web/src/App.tsx", "scratch.txt", "new.ts"]);
  });

  it("is empty for a clean tree", () => {
    expect(porcelainPaths("")).toEqual([]);
    expect(porcelainPaths("\n  \n")).toEqual([]);
  });
});

describe("worktreeDirtyError", () => {
  it("names the paths it found", () => {
    expect(worktreeDirtyError(["a.ts", "b.ts"])).toContain("a.ts, b.ts");
    expect(worktreeDirtyError(["a.ts"])).toContain("worktree-dirty:");
  });

  it("caps the list and counts the rest", () => {
    const message = worktreeDirtyError(["a", "b", "c", "d", "e", "f", "g"]);
    expect(message).toContain("a, b, c, d, e, +2 more");
    expect(message).not.toContain(", f");
  });
});

describe("findIncompleteSamples", () => {
  it("lists a sample that lost a signal, naming it", () => {
    const broken = sample({
      id: "s2",
      signals: { ...sample().signals, critic: undefined },
      errors: ["critic: agent hit the max-turns limit after 9 turns"],
    });
    const found = findIncompleteSamples([sample(), broken]);
    expect(found).toEqual([
      {
        id: "s2",
        missing: ["critic"],
        errors: ["critic: agent hit the max-turns limit after 9 turns"],
      },
    ]);
  });

  it("lists a sample that recorded an error even with all four signals", () => {
    const dirty = sample({ errors: ["worktree-dirty: the run wrote into the shared worktree — x"] });
    expect(findIncompleteSamples([dirty])).toEqual([
      { id: "s1", missing: [], errors: dirty.errors },
    ]);
  });

  it("says nothing about a complete sample", () => {
    expect(findIncompleteSamples([sample()])).toEqual([]);
    expect(missingSignals(sample())).toEqual([]);
  });
});

describe("renderIncompleteWarning", () => {
  it("is empty when every sample is complete", () => {
    expect(renderIncompleteWarning([], "/runs/r1")).toBe("");
  });

  it("names the samples, the missing signals and how to re-collect them", () => {
    const warning = renderIncompleteWarning(
      [{ id: "skipper-67", missing: ["critic"], errors: ["critic: max-turns"] }],
      "/runs/r1",
    );
    expect(warning).toContain("1 sample(s) are incomplete");
    expect(warning).toContain("Delete the sample's JSON in /runs/r1");
    expect(warning).toContain("skipper-67 — missing: critic");
    expect(warning).toContain("critic: max-turns");
  });
});

describe("renderCalibrationReport", () => {
  it("renders a one-row corpus", () => {
    const rows = buildCalibrationRows([sample()], { s1: "approve-unread" }, DEFAULT_CONFIDENCE_WEIGHTS);
    const md = renderCalibrationReport(rows, META);
    expect(md).toContain("# Confidence calibration — run run-1");
    expect(md).toContain("| sample | ground | critic | clarity | converg | composite | veto | label |");
    expect(md).toContain("show how many todos are left");
    expect(md).toContain("checkable outcomes, one open decision the plan flags");
    expect(md).toContain("verdict: concerns");
    expect(md).toContain("approve-unread");
    expect(md).toContain("claude-cli / sonnet");
  });

  it("renders a vetoed sample and marks it excluded", () => {
    const rows = buildCalibrationRows(
      [sample({ id: "v", veto: { signal: "groundedness", detail: "2 cited files are absent" } })],
      {},
      DEFAULT_CONFIDENCE_WEIGHTS,
    );
    const md = renderCalibrationReport(rows, META);
    expect(md).toContain("VETO (groundedness): 2 cited files are absent");
    expect(md).toContain("Excluded (groundedness veto): v");
  });
});

describe("resolvePlannerPair", () => {
  const settings = (over: Partial<OrchestratorSettings> = {}): OrchestratorSettings => ({
    ...DEFAULT_ORCHESTRATOR_SETTINGS,
    ...over,
  });

  it("falls back to the claude-cli floor on llm.claudeModel", () => {
    const pair = resolvePlannerPair("cicababba/skipper", {
      settings: settings(),
      repoSettings: {},
      claudeModel: "opus",
    });
    expect(pair).toEqual({
      runtime: "claude-cli",
      model: "opus",
      rung: "claude-cli floor on llm.claudeModel",
    });
  });

  it("takes the global default pair when no planner pair is set", () => {
    const pair = resolvePlannerPair("cicababba/skipper", {
      settings: settings({ defaultAgent: { runtime: "codex-cli", model: "gpt-5" } }),
      repoSettings: {},
      claudeModel: "opus",
    });
    expect(pair).toEqual({ runtime: "codex-cli", model: "gpt-5", rung: "global defaultAgent" });
  });

  it("prefers the global planner pair over the global default", () => {
    const pair = resolvePlannerPair("cicababba/skipper", {
      settings: settings({
        plannerAgent: { runtime: "claude-cli", model: "sonnet" },
        defaultAgent: { runtime: "codex-cli", model: "gpt-5" },
      }),
      repoSettings: {},
      claudeModel: "opus",
    });
    expect(pair).toEqual({ runtime: "claude-cli", model: "sonnet", rung: "global plannerAgent" });
  });

  it("prefers the repo planner pair, whole, over every global rung", () => {
    const pair = resolvePlannerPair("cicababba/todos", {
      settings: settings({ plannerAgent: { runtime: "codex-cli", model: "gpt-5" } }),
      repoSettings: { "cicababba/todos": { plannerAgent: { runtime: "gemini-cli" } } },
      claudeModel: "opus",
    });
    expect(pair).toEqual({ runtime: "gemini-cli", model: "", rung: "repo plannerAgent" });
  });

  it("resolves a claude pair without a model of its own to llm.claudeModel", () => {
    const pair = resolvePlannerPair("cicababba/todos", {
      settings: settings({ plannerAgent: { runtime: "claude-cli" } }),
      repoSettings: {},
      claudeModel: "opus",
    });
    expect(pair.model).toBe("opus");
  });
});

describe("summarizePlannerPairs", () => {
  const floor = (model: string): PlannerPair => ({
    runtime: "claude-cli",
    model,
    rung: "claude-cli floor on llm.claudeModel",
  });

  it("groups repos that share a pair and reports a single-pair corpus", () => {
    const summary = summarizePlannerPairs([
      { repo: "a/one", pair: floor("opus") },
      { repo: "a/two", pair: floor("opus") },
      { repo: "a/one", pair: floor("opus") },
    ]);
    expect(summary.mixed).toBe(false);
    expect(summary.groups).toEqual([
      { runtime: "claude-cli", model: "opus", rung: "claude-cli floor on llm.claudeModel", repos: ["a/one", "a/two"] },
    ]);
  });

  it("flags a corpus whose samples resolve to different pairs", () => {
    const summary = summarizePlannerPairs([
      { repo: "a/one", pair: floor("opus") },
      { repo: "a/two", pair: floor("sonnet") },
    ]);
    expect(summary.mixed).toBe(true);
    expect(summary.groups).toHaveLength(2);
  });

  it("keeps two rungs apart even when they land on the same pair", () => {
    const summary = summarizePlannerPairs([
      { repo: "a/one", pair: floor("opus") },
      { repo: "a/two", pair: { runtime: "claude-cli", model: "opus", rung: "repo plannerAgent" } },
    ]);
    expect(summary.mixed).toBe(false);
    expect(summary.groups).toHaveLength(2);
  });
});

describe("renderPlannerPairBanner", () => {
  const summary = summarizePlannerPairs([
    {
      repo: "cicababba/skipper",
      pair: { runtime: "claude-cli", model: "opus", rung: "claude-cli floor on llm.claudeModel" },
    },
  ]);

  it("names the pair, the settings file and the ladder rung it came from", () => {
    const banner = renderPlannerPairBanner(summary, {
      claudeModel: "opus",
      settingsFile: "/repo/data/settings.json",
      manifestFile: "/userData/orchestrator-manifest.json",
    });
    expect(banner).toContain("llm.claudeModel: opus — /repo/data/settings.json");
    expect(banner).toContain("/userData/orchestrator-manifest.json");
    expect(banner).toContain(
      "claude-cli / opus — claude-cli floor on llm.claudeModel — cicababba/skipper",
    );
    expect(banner).not.toContain("MIXED PAIRS");
  });

  it("says which file was missing instead of implying one was read", () => {
    const banner = renderPlannerPairBanner(summary, { claudeModel: "sonnet" });
    expect(banner).toContain("no settings.json found");
    expect(banner).toContain("no orchestrator-manifest.json found");
  });

  it("shows an empty model as the CLI's own default", () => {
    const gemini = summarizePlannerPairs([
      { repo: "a/one", pair: { runtime: "gemini-cli", model: "", rung: "repo plannerAgent" } },
    ]);
    expect(renderPlannerPairBanner(gemini, { claudeModel: "opus" })).toContain(
      "gemini-cli / (CLI default)",
    );
  });

  it("shouts when the corpus mixes pairs", () => {
    const mixed = summarizePlannerPairs([
      { repo: "a/one", pair: { runtime: "claude-cli", model: "opus", rung: "repo plannerAgent" } },
      { repo: "a/two", pair: { runtime: "claude-cli", model: "sonnet", rung: "repo plannerAgent" } },
    ]);
    expect(renderPlannerPairBanner(mixed, { claudeModel: "opus" })).toContain("MIXED PAIRS");
  });
});

describe("overridePlannerPair", () => {
  const resolved: PlannerPair = {
    runtime: "claude-cli",
    model: "opus",
    rung: "claude-cli floor on llm.claudeModel",
  };

  it("keeps the resolved pair when nothing is overridden", () => {
    expect(overridePlannerPair(resolved, {}, "opus")).toBe(resolved);
  });

  it("swaps only the model, keeping the resolved runtime", () => {
    expect(overridePlannerPair(resolved, { model: "sonnet" }, "opus")).toEqual({
      runtime: "claude-cli",
      model: "sonnet",
      rung: "command-line override",
    });
  });

  it("drops the claude model when the runtime is overridden alone", () => {
    expect(overridePlannerPair(resolved, { runtime: "codex-cli" }, "opus")).toEqual({
      runtime: "codex-cli",
      model: "",
      rung: "command-line override",
    });
  });

  it("takes the claude floor when claude-cli is the overridden runtime", () => {
    const gemini: PlannerPair = { runtime: "gemini-cli", model: "", rung: "repo plannerAgent" };
    expect(overridePlannerPair(gemini, { runtime: "claude-cli" }, "opus").model).toBe("opus");
  });

  it("takes both when both are given", () => {
    expect(overridePlannerPair(resolved, { runtime: "codex-cli", model: "gpt-5" }, "opus")).toEqual({
      runtime: "codex-cli",
      model: "gpt-5",
      rung: "command-line override",
    });
  });
});
