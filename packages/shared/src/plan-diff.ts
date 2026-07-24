// Structural diff between two IssuePlan bodies, rendered at the plan gate (#165).
// Deterministic and verifiable — no LLM summaries, no word-level diff. Files are
// matched by path, steps by title, acceptance formatted then string-diffed; a
// retitled step or a changed acceptance.addressedBy shows as removed + added.
// Pure module — no React.

import type { IssuePlan, PlanAcceptance, PlanFileRef, PlanStep } from "./plan";

export interface StringListDiff {
  added: string[];
  removed: string[];
}

export interface FilesDiff {
  added: PlanFileRef[];
  removed: PlanFileRef[];
  modified: { before: PlanFileRef; after: PlanFileRef }[];
}

export interface StepsDiff {
  added: PlanStep[];
  removed: PlanStep[];
  modified: { before: PlanStep; after: PlanStep }[];
}

export interface PlanDiff {
  summary: { before: string; after: string } | null;
  size: { before: IssuePlan["estimatedSize"]; after: IssuePlan["estimatedSize"] } | null;
  steps: StepsDiff;
  files: FilesDiff;
  acceptance: StringListDiff;
  risks: StringListDiff;
  openQuestions: StringListDiff;
  context: StringListDiff;
  outOfScope: StringListDiff;
  verificationCommands: StringListDiff;
  manualChecks: StringListDiff;
}

function diffStringList(before: string[], after: string[]): StringListDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((s) => !beforeSet.has(s)),
    removed: before.filter((s) => !afterSet.has(s)),
  };
}

function diffFiles(before: PlanFileRef[], after: PlanFileRef[]): FilesDiff {
  const beforeByPath = new Map(before.map((f) => [f.path, f]));
  const afterByPath = new Map(after.map((f) => [f.path, f]));
  const added = after.filter((f) => !beforeByPath.has(f.path));
  const removed = before.filter((f) => !afterByPath.has(f.path));
  const modified: FilesDiff["modified"] = [];
  for (const b of before) {
    const a = afterByPath.get(b.path);
    if (a && (a.reason !== b.reason || a.status !== b.status)) modified.push({ before: b, after: a });
  }
  return { added, removed, modified };
}

function stepFieldsEqual(a: PlanStep, b: PlanStep): boolean {
  return (
    a.detail === b.detail &&
    a.files.join("\n") === b.files.join("\n") &&
    a.symbols.join("\n") === b.symbols.join("\n") &&
    (a.createdSymbols ?? []).join("\n") === (b.createdSymbols ?? []).join("\n")
  );
}

function diffSteps(before: PlanStep[], after: PlanStep[]): StepsDiff {
  const beforeByTitle = new Map(before.map((s) => [s.title, s]));
  const afterByTitle = new Map(after.map((s) => [s.title, s]));
  const added = after.filter((s) => !beforeByTitle.has(s.title));
  const removed = before.filter((s) => !afterByTitle.has(s.title));
  const modified: StepsDiff["modified"] = [];
  for (const b of before) {
    const a = afterByTitle.get(b.title);
    if (a && !stepFieldsEqual(a, b)) modified.push({ before: b, after: a });
  }
  return { added, removed, modified };
}

/** The matching key for one acceptance row — shared with the views so highlights line up. */
export function acceptanceString(a: PlanAcceptance): string {
  return `${a.criterion} — ${a.addressedBy}`;
}

function acceptanceStrings(plan: IssuePlan): string[] {
  return plan.acceptance.map(acceptanceString);
}

export function diffPlans(before: IssuePlan, after: IssuePlan): PlanDiff {
  return {
    summary: before.summary === after.summary ? null : { before: before.summary, after: after.summary },
    size:
      before.estimatedSize === after.estimatedSize
        ? null
        : { before: before.estimatedSize, after: after.estimatedSize },
    steps: diffSteps(before.steps, after.steps),
    files: diffFiles(before.files, after.files),
    acceptance: diffStringList(acceptanceStrings(before), acceptanceStrings(after)),
    risks: diffStringList(before.risks, after.risks),
    openQuestions: diffStringList(before.openQuestions, after.openQuestions),
    context: diffStringList(before.context ?? [], after.context ?? []),
    outOfScope: diffStringList(before.outOfScope ?? [], after.outOfScope ?? []),
    verificationCommands: diffStringList(
      before.verificationCommands ?? [],
      after.verificationCommands ?? [],
    ),
    manualChecks: diffStringList(before.manualChecks ?? [], after.manualChecks ?? []),
  };
}

export function diffCount(diff: PlanDiff): number {
  let n = 0;
  if (diff.summary) n += 1;
  if (diff.size) n += 1;
  n += diff.steps.added.length + diff.steps.removed.length + diff.steps.modified.length;
  n += diff.files.added.length + diff.files.removed.length + diff.files.modified.length;
  for (const key of [
    "acceptance",
    "risks",
    "openQuestions",
    "context",
    "outOfScope",
    "verificationCommands",
    "manualChecks",
  ] as const) {
    n += diff[key].added.length + diff[key].removed.length;
  }
  return n;
}

export type DiffSectionKey =
  | "summary"
  | "size"
  | "steps"
  | "files"
  | "acceptance"
  | "risks"
  | "openQuestions"
  | "context"
  | "outOfScope"
  | "verificationCommands"
  | "manualChecks";

/** Per-section change counts; values sum to diffCount(diff). Aggregation only. */
export function sectionDiffCounts(diff: PlanDiff): Record<DiffSectionKey, number> {
  return {
    summary: diff.summary ? 1 : 0,
    size: diff.size ? 1 : 0,
    steps: diff.steps.added.length + diff.steps.removed.length + diff.steps.modified.length,
    files: diff.files.added.length + diff.files.removed.length + diff.files.modified.length,
    acceptance: diff.acceptance.added.length + diff.acceptance.removed.length,
    risks: diff.risks.added.length + diff.risks.removed.length,
    openQuestions: diff.openQuestions.added.length + diff.openQuestions.removed.length,
    context: diff.context.added.length + diff.context.removed.length,
    outOfScope: diff.outOfScope.added.length + diff.outOfScope.removed.length,
    verificationCommands:
      diff.verificationCommands.added.length + diff.verificationCommands.removed.length,
    manualChecks: diff.manualChecks.added.length + diff.manualChecks.removed.length,
  };
}
