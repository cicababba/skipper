import {
  DEFAULT_EXTRA_PLAN_RUNS,
  type ConfidenceReport,
  type ConfidenceThresholds,
  type ConfidenceWeights,
  type GateMode,
  type IssuePlan,
} from "@skipper/shared";
import type { LLMProviderInterface } from "../llm";
import { generatePlan as realGeneratePlan, type PlanIssueInput } from "../planner";
import { scoreClarity } from "./clarity";
import { scoreConvergence } from "./convergence";
import { critiquePlan } from "./critic";
import { DEFAULT_CONFIDENCE_THRESHOLDS, resolveGate } from "./gate";
import { scoreGroundedness } from "./groundedness";

export const DEFAULT_CONFIDENCE_WEIGHTS: ConfidenceWeights = {
  groundedness: 0.35,
  critic: 0.3,
  convergence: 0.25,
  clarity: 0.1,
};

export interface ComputeConfidenceOptions {
  plan: IssuePlan;
  issue: PlanIssueInput;
  repoPath: string;
  llm: LLMProviderInterface;
  /** Extra generatePlan runs feeding convergence (N total = 1 + this). */
  extraPlanRuns?: number;
  /** Gate bands used to decide whether the extra runs can change the outcome. */
  thresholds?: ConfidenceThresholds;
  /**
   * Repo-resolved autoCoding (#62), so the skip is computed for the gate that
   * will actually run. Optional — unlike resolveGate's required param — because
   * this is public core API where every knob defaults; "auto" is the conservative
   * choice (it skips least).
   */
  autoCoding?: GateMode;
  deps?: { generatePlan?: typeof realGeneratePlan };
}

/**
 * Gate range still reachable once convergence lands anywhere in [0,1], given
 * the signals already scored. composite(c) = (A + Wc·c) / (Wother + Wc) is
 * monotone in c, so the endpoints bound it. The absent-convergence composite
 * A/Wother also falls inside this band (A ≤ Wother, since every score ≤ 1),
 * so a band that resolves to one gate resolves to it however we score.
 */
export function reachableBand(
  signals: ConfidenceReport["signals"],
): { min: number; max: number } {
  const present = presentSignals(signals).filter(([k]) => k !== "convergence");
  const raw = present.reduce((sum, [k, s]) => sum + DEFAULT_CONFIDENCE_WEIGHTS[k] * s.score, 0);
  const other = present.reduce((sum, [k]) => sum + DEFAULT_CONFIDENCE_WEIGHTS[k], 0);
  const wc = DEFAULT_CONFIDENCE_WEIGHTS.convergence;
  return { min: raw / (other + wc), max: (raw + wc) / (other + wc) };
}

function presentSignals(
  signals: ConfidenceReport["signals"],
): [keyof ConfidenceWeights, { score: number }][] {
  return Object.entries(signals).filter(([, s]) => s !== undefined) as [
    keyof ConfidenceWeights,
    { score: number },
  ][];
}

/**
 * Composite, verifiable confidence (issue #8). Never throws: each signal is
 * scored independently, failures land in report.errors and the weights
 * renormalize over what succeeded. An all-failed report has composite 0 and
 * empty signals — the caller treats that as "no score" and falls back to the
 * conservative gate.
 */
export async function computeConfidence(
  opts: ComputeConfidenceOptions,
): Promise<ConfidenceReport> {
  const extraRuns = opts.extraPlanRuns ?? DEFAULT_EXTRA_PLAN_RUNS;
  const thresholds = opts.thresholds ?? DEFAULT_CONFIDENCE_THRESHOLDS;
  const autoCoding = opts.autoCoding ?? "auto";
  const generate = opts.deps?.generatePlan ?? realGeneratePlan;

  const report: ConfidenceReport = {
    version: 1,
    composite: 0,
    weights: { groundedness: 0, convergence: 0, critic: 0, clarity: 0 },
    signals: {},
    errors: [],
    computedAt: new Date().toISOString(),
  };

  try {
    report.signals.clarity = scoreClarity(opts.issue.body, opts.plan);
  } catch (err) {
    report.errors.push(`clarity: ${message(err)}`);
  }

  // The cheap signals settle first: they decide whether the extra plan runs can
  // still move the gate. Costs the critic's latency on the non-skip path, saves
  // two full agentic runs whenever the outcome is already pinned (#50).
  await Promise.all([
    scoreGroundedness(opts.plan, opts.repoPath)
      .then((s) => void (report.signals.groundedness = s))
      .catch((err) => void report.errors.push(`groundedness: ${message(err)}`)),
    critiquePlan(opts.plan, opts.issue, opts.llm)
      .then((s) => void (report.signals.critic = s))
      .catch((err) => void report.errors.push(`critic: ${message(err)}`)),
  ]);

  const skip = shouldSkipConvergence(report.signals, extraRuns, thresholds, autoCoding);
  if (skip) {
    report.convergenceSkipped = skip;
  } else {
    const settled = await Promise.allSettled(
      Array.from({ length: extraRuns }, () =>
        generate({ issue: opts.issue, repoPath: opts.repoPath, llm: opts.llm }),
      ),
    );
    const extra = settled
      .filter((r): r is PromiseFulfilledResult<IssuePlan> => r.status === "fulfilled")
      .map((r) => r.value);
    const failed = settled.length - extra.length;
    if (failed > 0) report.errors.push(`convergence: ${failed}/${settled.length} extra plan runs failed`);
    if (extra.length > 0) {
      try {
        report.signals.convergence = scoreConvergence([opts.plan, ...extra]);
      } catch (err) {
        report.errors.push(`convergence: ${message(err)}`);
      }
    }
  }

  const present = presentSignals(report.signals);
  const totalWeight = present.reduce((sum, [k]) => sum + DEFAULT_CONFIDENCE_WEIGHTS[k], 0);
  if (totalWeight > 0) {
    for (const [k] of present) {
      report.weights[k] = DEFAULT_CONFIDENCE_WEIGHTS[k] / totalWeight;
    }
    report.composite = present.reduce((sum, [k, s]) => sum + s.score * report.weights[k], 0);
  }
  return report;
}

function shouldSkipConvergence(
  signals: ConfidenceReport["signals"],
  extraRuns: number,
  thresholds: ConfidenceThresholds,
  mode: GateMode,
): ConfidenceReport["convergenceSkipped"] {
  if (extraRuns <= 0) {
    return { reason: "disabled", detail: "extraPlanRuns is 0 — convergence needs 2+ plans" };
  }
  const { min, max } = reachableBand(signals);
  const gate = resolveGate(min, thresholds, mode);
  if (gate !== resolveGate(max, thresholds, mode)) return undefined;
  return {
    reason: "decisive",
    detail: `composite in [${min.toFixed(2)}, ${max.toFixed(2)}] → ${gate} for any convergence value`,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
