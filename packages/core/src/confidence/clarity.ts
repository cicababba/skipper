import { z } from "zod";
import { displayKey, type ClaritySignal, type IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm";
import type { AgentRuntime } from "../runtime/types";
import { structuredCall } from "../runtime/structured";
import { renderCommentsBlock, type PlanIssueInput } from "../planner";

// Semantic clarity judge (#309): the structural heuristic it replaces gave the
// same score to a surgical issue and a vague one. Judged with no tools — the
// repo-fact side is the critic's job.

const MAX_BODY_CHARS = 12_000;

const CRITERIA_BASE: Record<"verifiable" | "partial" | "vague", number> = {
  verifiable: 1.0,
  partial: 0.85,
  vague: 0.2,
};
/** Decay per unresolved ambiguity (#315). Light on purpose: the count tracks
 *  how much an issue covers, not how badly it is written. */
const AMBIGUITY_DECAY = 0.05;
/** Weights inside the decay exponent, keeping the 0.15 / 0.05 / 0.10 ratios the
 *  linear penalties had: raising the hand must still cost a third of deciding
 *  in silence. */
const FLAGGED_WEIGHT = 1 / 3;
const REPO_QUESTION_WEIGHT = 2 / 3;

export const ClarityJudgmentSchema = z.object({
  criteria: z.enum(["verifiable", "partial", "vague"]),
  ambiguities: z.array(
    z.object({
      detail: z.string().min(1),
      resolvableFromRepo: z.boolean(),
      flaggedByPlan: z.boolean(),
    }),
  ),
  openQuestions: z.array(
    z.object({
      question: z.string().min(1),
      kind: z.enum(["issue-ambiguity", "repo-knowledge"]),
    }),
  ),
  rationale: z.string(),
});

export type ClarityJudgment = z.infer<typeof ClarityJudgmentSchema>;

export class ClarityError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "ClarityError";
  }
}

/**
 * Score derived here, never model-emitted — keeps it reproducible. A flagged
 * ambiguity costs a third of a silent one: raising the hand must raise the
 * score, not lower it as the old openQuestionCount penalty did.
 *
 * The count decays the base instead of being subtracted from it (#315): the
 * linear penalty sank below zero on half of the calibration corpus, so the
 * clamp flattened a curated issue and a one-line "make it less ugly" onto the
 * same 0.00. The criteria scale is not linear either — "vague" is the signature
 * of an issue that cannot be planned at all, while "partial" is an ordinary
 * one, so the drop from partial to vague is far larger than from verifiable to
 * partial.
 */
export function deriveClarityScore(judgment: ClarityJudgment): number {
  const unresolved = judgment.ambiguities.filter((a) => !a.resolvableFromRepo);
  const silent = unresolved.filter((a) => !a.flaggedByPlan).length;
  const flagged = unresolved.length - silent;
  const repoQuestions = judgment.openQuestions.filter((q) => q.kind === "repo-knowledge").length;
  const charged = silent + FLAGGED_WEIGHT * flagged + REPO_QUESTION_WEIGHT * repoQuestions;
  return CRITERIA_BASE[judgment.criteria] * Math.exp(-AMBIGUITY_DECAY * charged);
}

export function buildClarityPrompt(issue: PlanIssueInput, plan: IssuePlan): string {
  const body =
    issue.body && issue.body.length > MAX_BODY_CHARS
      ? `${issue.body.slice(0, MAX_BODY_CHARS)}\n[... issue body truncated ...]`
      : issue.body;
  const comments = renderCommentsBlock(issue.comments);
  return [
    `You are judging how CLEARLY an issue is specified. Judge the ISSUE, not the quality of the plan — whether the plan is a good solution is somebody else's job.`,
    ``,
    `Issue ${displayKey(issue.key)}: ${issue.title}`,
    ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(", ")}`] : []),
    ``,
    body ? `--- Issue body ---\n${body}\n--- End issue body ---` : `(The issue has no body.)`,
    ...(comments ? [``, comments] : []),
    ``,
    `--- Plan written from this issue ---`,
    `Summary: ${plan.summary}`,
    `Acceptance criteria the plan commits to:`,
    ...(plan.acceptance.length > 0
      ? plan.acceptance.map((a) => `- ${a.criterion} → ${a.addressedBy}`)
      : ["(none)"]),
    `Open questions the plan raises:`,
    ...(plan.openQuestions.length > 0
      ? plan.openQuestions.map((q) => `- ${q}`)
      : ["(none — the plan raised no questions)"]),
    `--- End plan ---`,
    ``,
    `Answer three things.`,
    ``,
    `1. "criteria": can an outsider tell OBJECTIVELY whether the change is done? "verifiable" when the issue states checkable outcomes, "partial" when some outcomes are checkable and others are left to taste, "vague" when done-ness is a judgment call.`,
    ``,
    `2. "ambiguities": every decision the issue leaves open that the implementer must settle — a value, a default, a shape, an interaction, an ordering. For each: "resolvableFromRepo": true when an existing convention in the codebase settles it without asking a human; "flaggedByPlan": true when the plan's open questions above genuinely raise it, false when the plan silently decided it instead. Read the plan's summary and acceptance criteria to spot decisions it made that the issue never specified. An issue with nothing genuinely open has an empty list.`,
    ``,
    `3. "openQuestions": classify EACH open question the plan raises. "issue-ambiguity" when it asks about something the issue genuinely left open; "repo-knowledge" when it asks about something already discoverable in the codebase, i.e. the planner did not explore enough.`,
    ``,
    `Finally, "rationale": one line explaining the judgment.`,
  ].join("\n");
}

/** Semantic issue-clarity judgment (#309). No tools, single turn. */
export async function scoreClarity(
  issue: PlanIssueInput,
  plan: IssuePlan,
  llm: LLMProviderInterface,
  opts?: { runtime?: AgentRuntime; signal?: AbortSignal },
): Promise<ClaritySignal> {
  const schema = z.toJSONSchema(ClarityJudgmentSchema) as Record<string, unknown>;
  const reply = await structuredCall<unknown>(
    opts?.runtime,
    llm,
    buildClarityPrompt(issue, plan),
    schema,
    opts?.signal ? { signal: opts.signal } : undefined,
  );
  const parsed = ClarityJudgmentSchema.safeParse(reply);
  if (!parsed.success) {
    throw new ClarityError(`clarity judge returned an invalid judgment: ${parsed.error.message}`, reply);
  }
  const judgment = parsed.data;
  return {
    score: deriveClarityScore(judgment),
    criteria: judgment.criteria,
    ambiguities: judgment.ambiguities,
    openQuestions: judgment.openQuestions,
    rationale: judgment.rationale,
  };
}
