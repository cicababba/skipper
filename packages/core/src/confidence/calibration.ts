import {
  resolveRepoOrchestratorSettings,
  type AgentRuntimeId,
  type ClaritySignal,
  type ConfidenceWeights,
  type ConvergenceSignal,
  type CriticObjection,
  type CriticSignal,
  type CriticVerdict,
  type GroundednessSignal,
  type IssuePlan,
  type OrchestratorSettings,
  type RepoIntakeSettings,
} from "@skipper/shared";
import { deriveClarityScore, type ClarityJudgment } from "./clarity";
import { deriveConvergenceScore } from "./convergence";
import { deriveCriticScore } from "./critic";

// Threshold-calibration corpus (#314). The harness that collects it never calls
// computeConfidence: that function may skip the convergence runs when the gate
// outcome is already pinned, and the skip is decided by the very thresholds
// under calibration — so a sample collected through it would be shaped by the
// numbers it is meant to measure. It orchestrates the four signals itself and
// composes them here, with the same math.

/**
 * Wider than `keyof ConfidenceWeights` on purpose: groundedness is measured but
 * no longer weighted (#321), and the corpus must keep reporting it — it is the
 * evidence the signal is constant. `compositeOf` iterates the weight keys, so it
 * excludes groundedness by itself, exactly as production does.
 */
export type CalibrationSignalKey = "groundedness" | "critic" | "clarity" | "convergence";

export type CalibrationScores = Partial<Record<CalibrationSignalKey, number>>;

/**
 * The human judgment the thresholds are fitted against. `approve-unread`: the
 * plan would have been queued without reading it. `wants-to-read`: the plan gate
 * was wanted. `not-plannable`: the issue is too broken to plan at all.
 */
export type CalibrationLabel = "approve-unread" | "wants-to-read" | "not-plannable";

export interface CalibrationPlanDigest {
  summary: string;
  fileCount: number;
  stepCount: number;
  estimatedSize: IssuePlan["estimatedSize"];
  openQuestions: string[];
}

export function planDigest(plan: IssuePlan): CalibrationPlanDigest {
  return {
    summary: plan.summary,
    fileCount: plan.files.length,
    stepCount: plan.steps.length,
    estimatedSize: plan.estimatedSize,
    openQuestions: plan.openQuestions,
  };
}

export interface CalibrationTimings {
  planMs: number;
  extraPlansMs: number;
  scoringMs: number;
  totalMs: number;
}

/** One collected sample: everything needed to re-derive its score offline. */
export interface CalibrationSample {
  version: 1;
  id: string;
  repo: string;
  /** Where the issue text came from, e.g. "github:cicababba/skipper#139". */
  provenance: string;
  issueKey: string;
  issueTitle: string;
  issueUrl: string;
  plan: CalibrationPlanDigest;
  signals: {
    groundedness?: GroundednessSignal;
    critic?: CriticSignal;
    clarity?: ClaritySignal;
    convergence?: ConvergenceSignal;
  };
  /** Composite as measured at collection time, over the weights below. */
  composite: number;
  weights: ConfidenceWeights;
  veto?: { signal: "groundedness"; detail: string };
  runtime: string;
  model: string;
  graphify: boolean;
  timings: CalibrationTimings;
  errors: string[];
  collectedAt: string;
}

export interface ReplayOptions {
  /** Alternate clarity curve (#315 tries one without touching the shipped one). */
  deriveClarity?: (judgment: ClarityJudgment) => number;
  deriveCritic?: (verdict: CriticVerdict, objections: CriticObjection[]) => number;
  deriveConvergence?: (parts: { fileJaccard: number; stepCountAgreement: number }) => number;
}

export interface ReplayResult {
  scores: CalibrationScores;
  /** Signals whose raw judgment was missing, so the stored score was reused. */
  fallbacks: CalibrationSignalKey[];
}

/**
 * Re-derive the signals from what the sample stored under them, so a weight or
 * curve change is picked up without re-running any agent. Groundedness keeps its
 * stored score — its derivation is deterministic over repo facts the sample no
 * longer carries.
 */
export function replayScores(sample: CalibrationSample, opts?: ReplayOptions): ReplayResult {
  const scores: CalibrationScores = {};
  const fallbacks: CalibrationSignalKey[] = [];

  const { groundedness, convergence, clarity, critic } = sample.signals;
  if (groundedness) scores.groundedness = groundedness.score;

  if (convergence) {
    const parts = convergencePartsOf(convergence);
    if (parts) {
      scores.convergence = (opts?.deriveConvergence ?? deriveConvergenceScore)(parts);
    } else {
      scores.convergence = convergence.score;
      fallbacks.push("convergence");
    }
  }

  if (clarity) {
    const judgment = clarityJudgmentOf(clarity);
    if (judgment) {
      scores.clarity = (opts?.deriveClarity ?? deriveClarityScore)(judgment);
    } else {
      scores.clarity = clarity.score;
      fallbacks.push("clarity");
    }
  }

  if (critic) {
    if (critic.verdict && Array.isArray(critic.objections)) {
      scores.critic = (opts?.deriveCritic ?? deriveCriticScore)(critic.verdict, critic.objections);
    } else {
      scores.critic = critic.score;
      fallbacks.push("critic");
    }
  }

  return { scores, fallbacks };
}

function convergencePartsOf(
  signal: ConvergenceSignal,
): { fileJaccard: number; stepCountAgreement: number } | undefined {
  const { fileJaccard, stepCountAgreement } = signal as Partial<ConvergenceSignal>;
  if (typeof fileJaccard !== "number" || typeof stepCountAgreement !== "number") return undefined;
  return { fileJaccard, stepCountAgreement };
}

function clarityJudgmentOf(signal: ClaritySignal): ClarityJudgment | undefined {
  if (!signal.criteria || !signal.ambiguities || !signal.openQuestions) return undefined;
  return {
    criteria: signal.criteria,
    ambiguities: signal.ambiguities,
    openQuestions: signal.openQuestions,
    rationale: signal.rationale ?? "",
  };
}

/** Weighted sum over the signals present, renormalized over their weights. */
export function compositeOf(scores: CalibrationScores, weights: ConfidenceWeights): number {
  const present = (Object.keys(weights) as (keyof ConfidenceWeights)[]).filter(
    (k) => scores[k] !== undefined,
  );
  const total = present.reduce((sum, k) => sum + weights[k], 0);
  if (total === 0) return 0;
  return present.reduce((sum, k) => sum + scores[k]! * (weights[k] / total), 0);
}

const ALL_SIGNALS: CalibrationSignalKey[] = ["groundedness", "critic", "clarity", "convergence"];

/** Detail cap so one runaway run cannot flood the sample's errors. */
const MAX_DIRTY_PATHS = 5;

/** Paths out of `git status --porcelain`, rename arrows resolved to the target. */
export function porcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space === -1) continue;
    let rest = trimmed.slice(space + 1).trim();
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) rest = rest.slice(arrow + 4).trim();
    if (rest) paths.push(rest);
  }
  return paths;
}

/**
 * A plan run must never write: the calibration worktree is shared by every
 * sample of its repo, so one escaped write would silently pollute the rest of
 * the corpus (the #156–#159 lesson, with no production tripwire here).
 */
export function worktreeDirtyError(paths: string[]): string {
  const shown = paths.slice(0, MAX_DIRTY_PATHS);
  const extra = paths.length - shown.length;
  return `worktree-dirty: the run wrote into the shared worktree — ${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`;
}

export interface IncompleteSample {
  id: string;
  missing: CalibrationSignalKey[];
  errors: string[];
}

export function missingSignals(sample: CalibrationSample): CalibrationSignalKey[] {
  return ALL_SIGNALS.filter((k) => sample.signals[k] === undefined);
}

/** Samples that lost a signal or recorded an error — an incomplete corpus. */
export function findIncompleteSamples(samples: CalibrationSample[]): IncompleteSample[] {
  return samples
    .map((sample) => ({
      id: sample.id,
      missing: missingSignals(sample),
      errors: sample.errors,
    }))
    .filter((s) => s.missing.length > 0 || s.errors.length > 0);
}

/**
 * The end-of-collect warning. The resume skip deliberately keeps an existing
 * sample (re-running a good one is expensive), so an incomplete sample would
 * otherwise stay silently incomplete across every later run.
 */
export function renderIncompleteWarning(incomplete: IncompleteSample[], runDir: string): string {
  if (incomplete.length === 0) return "";
  const lines = [
    `WARNING: ${incomplete.length} sample(s) are incomplete. Delete the sample's JSON in ${runDir} to re-collect it — resuming keeps whatever is already on disk.`,
  ];
  for (const s of incomplete) {
    lines.push(
      `  ${s.id}${s.missing.length > 0 ? ` — missing: ${s.missing.join(", ")}` : ""}`,
      ...s.errors.map((e) => `      ${e}`),
    );
  }
  return lines.join("\n");
}

export interface CalibrationRow {
  sample: CalibrationSample;
  scores: CalibrationScores;
  composite: number;
  fallbacks: CalibrationSignalKey[];
  label?: CalibrationLabel;
}

export function buildCalibrationRows(
  samples: CalibrationSample[],
  labels: Record<string, CalibrationLabel>,
  weights: ConfidenceWeights,
  opts?: ReplayOptions,
): CalibrationRow[] {
  return samples.map((sample) => {
    const { scores, fallbacks } = replayScores(sample, opts);
    const label = labels[sample.id];
    return {
      sample,
      scores,
      composite: compositeOf(scores, weights),
      fallbacks,
      ...(label ? { label } : {}),
    };
  });
}

export interface ThresholdCandidate {
  value: number;
  /** Positive-class rows at or above the candidate. */
  kept: number;
  /** Negative-class rows that leak in at or above it. */
  leaked: number;
}

export interface ThresholdSweep {
  band: "high" | "low";
  positiveLabels: CalibrationLabel[];
  negativeLabels: CalibrationLabel[];
  positives: number;
  negatives: number;
  candidates: ThresholdCandidate[];
  /** Candidates keeping every positive with zero leakage; absent when none does. */
  separating?: { min: number; max: number };
  /**
   * Lowest positive composite minus highest negative composite. ≤ 0 means the
   * labels interleave and no threshold separates them. Undefined when either
   * class is unrepresented in the corpus.
   */
  margin?: number;
}

export interface SweepResult {
  high: ThresholdSweep;
  low: ThresholdSweep;
  /** Rows excluded from the decision: vetoed, or unlabeled. */
  excluded: { vetoed: string[]; unlabeled: string[] };
}

export interface SweepOptions {
  grid?: number[];
}

export function defaultThresholdGrid(): number[] {
  const grid: number[] = [];
  for (let v = 50; v <= 95; v++) grid.push(v / 100);
  return grid;
}

/**
 * A vetoed sample is needs-input whatever the thresholds say, so it never
 * constrains them — it stays in the report, out of the decision.
 */
export function sweepThresholds(rows: CalibrationRow[], opts?: SweepOptions): SweepResult {
  const grid = opts?.grid ?? defaultThresholdGrid();
  const vetoed = rows.filter((r) => r.sample.veto);
  const unlabeled = rows.filter((r) => !r.sample.veto && !r.label);
  const usable = rows.filter((r) => !r.sample.veto && r.label);
  return {
    high: sweepBand(usable, grid, "high", ["approve-unread"], ["wants-to-read"]),
    low: sweepBand(
      usable,
      grid,
      "low",
      ["approve-unread", "wants-to-read"],
      ["not-plannable"],
    ),
    excluded: {
      vetoed: vetoed.map((r) => r.sample.id),
      unlabeled: unlabeled.map((r) => r.sample.id),
    },
  };
}

function sweepBand(
  rows: CalibrationRow[],
  grid: number[],
  band: "high" | "low",
  positiveLabels: CalibrationLabel[],
  negativeLabels: CalibrationLabel[],
): ThresholdSweep {
  const positives = rows
    .filter((r) => r.label && positiveLabels.includes(r.label))
    .map((r) => r.composite);
  const negatives = rows
    .filter((r) => r.label && negativeLabels.includes(r.label))
    .map((r) => r.composite);

  const candidates = grid.map((value) => ({
    value,
    kept: positives.filter((c) => c >= value).length,
    leaked: negatives.filter((c) => c >= value).length,
  }));

  const clean = candidates.filter((c) => c.leaked === 0 && c.kept === positives.length);
  const separating =
    positives.length > 0 && clean.length > 0
      ? { min: Math.min(...clean.map((c) => c.value)), max: Math.max(...clean.map((c) => c.value)) }
      : undefined;
  const margin =
    positives.length > 0 && negatives.length > 0
      ? Math.min(...positives) - Math.max(...negatives)
      : undefined;

  return {
    band,
    positiveLabels,
    negativeLabels,
    positives: positives.length,
    negatives: negatives.length,
    candidates,
    ...(separating ? { separating } : {}),
    ...(margin !== undefined ? { margin } : {}),
  };
}

export interface CalibrationMeta {
  runId: string;
  runtime: string;
  model: string;
  graphify: boolean;
  weights: ConfidenceWeights;
  code?: { sha: string; dirty: boolean };
  generatedAt: string;
}

/** The markdown the user labels from, and the issue comment is trimmed from. */
export function renderCalibrationReport(rows: CalibrationRow[], meta: CalibrationMeta): string {
  const sorted = [...rows].sort((a, b) => b.composite - a.composite);
  const sweep = sweepThresholds(rows, undefined);
  const w = meta.weights;
  return [
    `# Confidence calibration — run ${meta.runId}`,
    ``,
    `- Samples: ${rows.length}`,
    `- Runtime / model: ${meta.runtime} / ${meta.model || "(CLI default)"}`,
    `- Graphify attached: ${meta.graphify ? "yes" : "no"}`,
    `- Weights: critic ${w.critic}, convergence ${w.convergence}, clarity ${w.clarity}`,
    ...(meta.code ? [`- Code: ${meta.code.sha}${meta.code.dirty ? " (dirty)" : ""}`] : []),
    `- Generated: ${meta.generatedAt}`,
    ``,
    `A calibration is only valid for the planner it was measured on.`,
    ``,
    `## Composites`,
    ``,
    `| sample | ground | critic | clarity | converg | composite | veto | label |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...sorted.map(
      (r) =>
        `| ${r.sample.id} | ${num(r.scores.groundedness)} | ${num(r.scores.critic)} | ${num(r.scores.clarity)} | ${num(r.scores.convergence)} | ${num(r.composite)} | ${r.sample.veto ? "yes" : ""} | ${r.label ?? ""} |`,
    ),
    ``,
    ...renderSweep(sweep),
    ``,
    `## Samples`,
    ...sorted.flatMap((r) => renderSample(r)),
  ].join("\n");
}

function renderSweep(sweep: SweepResult): string[] {
  const lines = [`## Threshold sweep`, ``];
  for (const band of [sweep.high, sweep.low]) {
    lines.push(
      `### \`${band.band}\` — keep ${band.positiveLabels.join(" + ")} above, exclude ${band.negativeLabels.join(" + ")}`,
      ``,
      `- Positives: ${band.positives}, negatives: ${band.negatives}`,
    );
    if (band.positives === 0 || band.negatives === 0) {
      lines.push(`- Not decidable: one of the two classes is unrepresented in the corpus.`);
    } else if (band.margin !== undefined && band.margin <= 0) {
      lines.push(
        `- Margin ${band.margin.toFixed(3)} — the labels interleave, no value separates them.`,
      );
    } else if (band.separating) {
      lines.push(
        `- Separating range: [${band.separating.min.toFixed(2)}, ${band.separating.max.toFixed(2)}], margin ${band.margin?.toFixed(3) ?? "n/a"}.`,
      );
    } else {
      lines.push(`- No candidate on the grid keeps every positive with zero leakage.`);
    }
    lines.push(``);
  }
  if (sweep.excluded.vetoed.length > 0) {
    lines.push(`Excluded (groundedness veto): ${sweep.excluded.vetoed.join(", ")}`, ``);
  }
  if (sweep.excluded.unlabeled.length > 0) {
    lines.push(`Excluded (unlabeled): ${sweep.excluded.unlabeled.join(", ")}`, ``);
  }
  return lines;
}

function renderSample(row: CalibrationRow): string[] {
  const s = row.sample;
  const clarity = s.signals.clarity;
  const critic = s.signals.critic;
  const lines = [
    ``,
    `### ${s.id} — composite ${num(row.composite)}${row.label ? ` — ${row.label}` : ""}`,
    ``,
    `- Issue: ${s.issueKey} ${s.issueTitle}`,
    `- Provenance: ${s.provenance}`,
    `- Plan: ${s.plan.summary}`,
    `- Size ${s.plan.estimatedSize}, ${s.plan.fileCount} files, ${s.plan.stepCount} steps`,
  ];
  if (s.veto) lines.push(`- VETO (${s.veto.signal}): ${s.veto.detail}`);
  if (row.fallbacks.length > 0) {
    lines.push(`- Replayed from stored score (raw judgment missing): ${row.fallbacks.join(", ")}`);
  }
  if (s.plan.openQuestions.length > 0) {
    lines.push(`- Plan open questions:`, ...s.plan.openQuestions.map((q) => `  - ${q}`));
  }
  if (clarity) {
    lines.push(
      ``,
      `**Clarity ${num(row.scores.clarity)}** — criteria: ${clarity.criteria ?? "n/a"}`,
      clarity.rationale ? `> ${clarity.rationale}` : `> (no rationale)`,
    );
    for (const a of clarity.ambiguities ?? []) {
      lines.push(
        `- ambiguity: ${a.detail} (repo-resolvable: ${a.resolvableFromRepo}, flagged by plan: ${a.flaggedByPlan})`,
      );
    }
    for (const q of clarity.openQuestions ?? []) {
      lines.push(`- open question [${q.kind}]: ${q.question}`);
    }
  }
  if (critic) {
    lines.push(``, `**Critic ${num(row.scores.critic)}** — verdict: ${critic.verdict}`);
    for (const o of critic.objections ?? []) {
      lines.push(
        `- [${o.kind}]${o.blocking ? " (blocking)" : ""}${o.unverified ? " (unverified)" : ""} ${o.detail}`,
      );
    }
  }
  if (s.errors.length > 0) {
    lines.push(``, `**Errors**`, ...s.errors.map((e) => `- ${e}`));
  }
  return lines;
}

function num(n: number | undefined): string {
  return n === undefined ? "—" : n.toFixed(3);
}

// Planner-pair resolution (#314). A calibration is only valid for the pair the
// app actually plans with, so the harness must never guess a model: it mirrors
// the app's own ladder here rather than defaulting to llm.claudeModel.

export type PlannerPairRung =
  | "repo plannerAgent"
  | "global plannerAgent"
  | "global defaultAgent"
  | "claude-cli floor on llm.claudeModel"
  | "command-line override";

export interface PlannerPair {
  runtime: AgentRuntimeId;
  model: string;
  rung: PlannerPairRung;
}

export interface PlannerPairInputs {
  /** manifest.settings — the global orchestrator settings bag. */
  settings: OrchestratorSettings;
  /** manifest.repoSettings, keyed by repoKey ("owner/name"). */
  repoSettings: Record<string, RepoIntakeSettings>;
  /** llm.claudeModel, merged over DEFAULT_LLM_SETTINGS the way the app merges it. */
  claudeModel: string;
}

/** The planner pair for one repo, down the same ladder resolveAgent walks. */
export function resolvePlannerPair(repo: string, inputs: PlannerPairInputs): PlannerPair {
  const repoSettings = inputs.repoSettings[repo];
  const resolved = resolveRepoOrchestratorSettings(repoSettings, inputs.settings, inputs.claudeModel);
  return {
    runtime: resolved.plannerRuntime,
    model: resolved.plannerModel,
    rung: plannerRung(repoSettings, inputs.settings),
  };
}

function plannerRung(
  repo: RepoIntakeSettings | undefined,
  global: OrchestratorSettings,
): PlannerPairRung {
  if (repo?.plannerAgent) return "repo plannerAgent";
  if (global.plannerAgent) return "global plannerAgent";
  if (global.defaultAgent) return "global defaultAgent";
  return "claude-cli floor on llm.claudeModel";
}

/**
 * A --runtime/--model override sits above the ladder as one atomic pair: an
 * overridden runtime with no model of its own takes the same floor resolveAgent
 * applies, so "codex-cli + a Claude alias" stays unreachable here too.
 */
export function overridePlannerPair(
  resolved: PlannerPair,
  override: { runtime?: AgentRuntimeId; model?: string },
  claudeModel: string,
): PlannerPair {
  if (override.runtime === undefined && override.model === undefined) return resolved;
  const runtime = override.runtime ?? resolved.runtime;
  const model =
    override.model?.trim() ||
    (override.runtime ? (runtime === "claude-cli" ? claudeModel : "") : resolved.model);
  return { runtime, model, rung: "command-line override" };
}

export interface PlannerPairGroup extends PlannerPair {
  /** Corpus repos that resolved to this pair through this rung, first seen first. */
  repos: string[];
}

export interface PlannerPairSummary {
  groups: PlannerPairGroup[];
  /** More than one distinct (runtime, model) across the corpus — not calibratable. */
  mixed: boolean;
}

export function summarizePlannerPairs(
  entries: Array<{ repo: string; pair: PlannerPair }>,
): PlannerPairSummary {
  const groups = new Map<string, PlannerPairGroup>();
  for (const { repo, pair } of entries) {
    const key = `${pair.runtime} ${pair.model} ${pair.rung}`;
    const group = groups.get(key) ?? { ...pair, repos: [] };
    if (!group.repos.includes(repo)) group.repos.push(repo);
    groups.set(key, group);
  }
  const distinct = new Set(entries.map((e) => `${e.pair.runtime} ${e.pair.model}`));
  return { groups: [...groups.values()], mixed: distinct.size > 1 };
}

export interface PlannerPairSources {
  /** settings.json the claudeModel came from; absent = none found, built-in default. */
  settingsFile?: string;
  claudeModel: string;
  /** orchestrator-manifest.json the ladder was read from; absent = none found. */
  manifestFile?: string;
}

/** Printed before the first agent run — dry runs included, so the pair that is
 *  about to be paid for is visible first. */
export function renderPlannerPairBanner(
  summary: PlannerPairSummary,
  sources: PlannerPairSources,
): string {
  const lines = [
    `planner pair — resolved the way the app resolves it:`,
    `  llm.claudeModel: ${sources.claudeModel || "(unset)"} — ${sources.settingsFile ?? "no settings.json found, using the built-in default"}`,
    `  ladder: ${sources.manifestFile ?? "no orchestrator-manifest.json found, using default settings"}`,
  ];
  for (const g of summary.groups) {
    lines.push(
      `  ${g.runtime} / ${g.model || "(CLI default)"} — ${g.rung} — ${g.repos.join(", ")}`,
    );
  }
  if (summary.mixed) {
    lines.push(
      ``,
      `!! MIXED PAIRS: this corpus resolves to more than one (runtime, model). A calibration is only valid for the planner it was measured on — collect one corpus per pair, or pin one with --runtime/--model.`,
    );
  }
  return lines.join("\n");
}
