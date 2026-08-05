import type { ConvergenceSignal, IssuePlan } from "@skipper/shared";

export const DIVERGENCE_THRESHOLD = 0.4;

const SIZE_ORDINAL: Record<IssuePlan["estimatedSize"], number> = {
  xs: 0,
  s: 1,
  m: 2,
  l: 3,
  xl: 4,
};

/**
 * `sizeAgreement` is measured and reported but carries no weight (#320): on the
 * #314 corpus it was a constant 1.000 on ten samples out of twelve and
 * correlated 0.000 with the human labels, while `stepCountAgreement` correlated
 * 0.627 on a weight of 0.15 — the weights were inverted with respect to how
 * much each component informed. Its 0.25 moved to the step-count agreement;
 * `fileJaccard` stayed where it was.
 */
const COMPONENT_WEIGHTS = { fileJaccard: 0.6, stepCountAgreement: 0.4 };

export function deriveConvergenceScore(parts: {
  fileJaccard: number;
  stepCountAgreement: number;
}): number {
  return (
    COMPONENT_WEIGHTS.fileJaccard * parts.fileJaccard +
    COMPONENT_WEIGHTS.stepCountAgreement * parts.stepCountAgreement
  );
}

/**
 * Deterministic agreement across independently generated plans — no LLM.
 * Semantic (LLM-judged) agreement is deliberately deferred past v1.
 */
export function scoreConvergence(plans: IssuePlan[]): ConvergenceSignal {
  if (plans.length < 2) {
    throw new Error(`convergence needs at least 2 plans, got ${plans.length}`);
  }
  const fileSets = plans.map(citedFiles);
  const fileJaccard = meanPairwiseJaccard(fileSets);

  const sizes = plans.map((p) => SIZE_ORDINAL[p.estimatedSize]);
  const sizeAgreement = 1 - (Math.max(...sizes) - Math.min(...sizes)) / 4;

  const stepCounts = plans.map((p) => p.steps.length);
  const maxSteps = Math.max(...stepCounts);
  const stepCountAgreement = maxSteps === 0 ? 1 : 1 - (maxSteps - Math.min(...stepCounts)) / maxSteps;

  const score = deriveConvergenceScore({ fileJaccard, stepCountAgreement });

  const allFiles = new Set(fileSets.flatMap((s) => [...s]));
  const sharedFiles = [...allFiles].filter((f) => fileSets.every((s) => s.has(f))).sort();
  const disputedFiles = [...allFiles].filter((f) => !fileSets.every((s) => s.has(f))).sort();

  return {
    score,
    planCount: plans.length,
    fileJaccard,
    sizeAgreement,
    stepCountAgreement,
    divergent: score < DIVERGENCE_THRESHOLD,
    sharedFiles,
    disputedFiles,
  };
}

function citedFiles(plan: IssuePlan): Set<string> {
  return new Set([...plan.files.map((f) => f.path), ...plan.steps.flatMap((s) => s.files)]);
}

function meanPairwiseJaccard(sets: Set<string>[]): number {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      sum += jaccard(sets[i], sets[j]);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
