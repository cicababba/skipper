import type {
  ConfidenceReport,
  ConfidenceWeights,
  IssuePlan,
} from "@nestbrain/shared";
import type { LLMProviderInterface } from "../llm";
import { generatePlan as realGeneratePlan, type PlanIssueInput } from "../planner";
import { scoreClarity } from "./clarity";
import { scoreConvergence } from "./convergence";
import { critiquePlan } from "./critic";
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
  deps?: { generatePlan?: typeof realGeneratePlan };
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
  const extraRuns = opts.extraPlanRuns ?? 2;
  const generate = opts.deps?.generatePlan ?? realGeneratePlan;

  const report: ConfidenceReport = {
    version: 1,
    composite: 0,
    weights: { groundedness: 0, convergence: 0, critic: 0, clarity: 0 },
    signals: {},
    errors: [],
    computedAt: new Date().toISOString(),
  };

  const tasks: Promise<void>[] = [
    scoreGroundedness(opts.plan, opts.repoPath)
      .then((s) => void (report.signals.groundedness = s))
      .catch((err) => void report.errors.push(`groundedness: ${message(err)}`)),
    critiquePlan(opts.plan, opts.issue, opts.llm)
      .then((s) => void (report.signals.critic = s))
      .catch((err) => void report.errors.push(`critic: ${message(err)}`)),
  ];

  if (extraRuns > 0) {
    tasks.push(
      Promise.allSettled(
        Array.from({ length: extraRuns }, () =>
          generate({ issue: opts.issue, repoPath: opts.repoPath, llm: opts.llm }),
        ),
      ).then((settled) => {
        const extra = settled
          .filter((r): r is PromiseFulfilledResult<IssuePlan> => r.status === "fulfilled")
          .map((r) => r.value);
        const failed = settled.length - extra.length;
        if (failed > 0) report.errors.push(`convergence: ${failed}/${settled.length} extra plan runs failed`);
        if (extra.length === 0) return;
        try {
          report.signals.convergence = scoreConvergence([opts.plan, ...extra]);
        } catch (err) {
          report.errors.push(`convergence: ${message(err)}`);
        }
      }),
    );
  }

  try {
    report.signals.clarity = scoreClarity(opts.issue.body, opts.plan);
  } catch (err) {
    report.errors.push(`clarity: ${message(err)}`);
  }

  await Promise.all(tasks);

  const present = Object.entries(report.signals).filter(([, s]) => s !== undefined) as [
    keyof ConfidenceWeights,
    { score: number },
  ][];
  const totalWeight = present.reduce((sum, [k]) => sum + DEFAULT_CONFIDENCE_WEIGHTS[k], 0);
  if (totalWeight > 0) {
    for (const [k] of present) {
      report.weights[k] = DEFAULT_CONFIDENCE_WEIGHTS[k] / totalWeight;
    }
    report.composite = present.reduce((sum, [k, s]) => sum + s.score * report.weights[k], 0);
  }
  return report;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
