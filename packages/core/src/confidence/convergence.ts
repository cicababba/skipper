import type { ConvergenceSignal, IssuePlan } from "@nestbrain/shared";

export const DIVERGENCE_THRESHOLD = 0.4;

const SIZE_ORDINAL: Record<IssuePlan["estimatedSize"], number> = {
  xs: 0,
  s: 1,
  m: 2,
  l: 3,
  xl: 4,
};

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

  const score = 0.6 * fileJaccard + 0.25 * sizeAgreement + 0.15 * stepCountAgreement;

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
