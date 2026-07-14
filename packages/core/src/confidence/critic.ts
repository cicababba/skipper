import { z } from "zod";
import type { CriticSignal, CriticVerdict, IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm";
import type { PlanIssueInput } from "../planner";

// Adversarial critic primitive (issue #8). Artifact-agnostic on purpose:
// #10 remounts it on a diff ("artifactKind: diff") without touching this file.

export interface CriticInput {
  artifactKind: "plan" | "diff";
  /** e.g. `implementation plan for issue #42`. */
  artifactLabel: string;
  /** Rendered plan JSON or unified diff. */
  artifact: string;
  /** Issue title + body + acceptance criteria. */
  context: string;
}

export const CriticVerdictSchema = z.object({
  verdict: z.enum(["approve", "concerns", "reject"]),
  objections: z.array(
    z.object({
      kind: z.enum([
        "missing-step",
        "wrong-approach",
        "risk",
        "acceptance-gap",
        "underspecified",
        "other",
      ]),
      detail: z.string().min(1),
      blocking: z.boolean(),
    }),
  ),
});

export class CriticError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "CriticError";
  }
}

const VERDICT_SCORE: Record<CriticVerdict, number> = {
  approve: 1.0,
  concerns: 0.6,
  reject: 0.2,
};
const BLOCKING_PENALTY = 0.1;

export function buildCriticPrompt(input: CriticInput): string {
  return [
    `You are an adversarial reviewer. Your job is to try to DEMOLISH the ${input.artifactKind} below — find every way it fails, misreads the issue, or would break the codebase. Do not be polite; be right.`,
    ``,
    `Artifact under review: ${input.artifactLabel}`,
    ``,
    `--- Context ---`,
    input.context,
    `--- End context ---`,
    ``,
    `--- ${input.artifactKind === "plan" ? "Plan" : "Diff"} ---`,
    input.artifact,
    `--- End ${input.artifactKind} ---`,
    ``,
    `Raise an objection ONLY for real, defensible problems; mark it blocking only when shipping as-is would be wrong. Verdict: "approve" if you failed to demolish it, "concerns" for non-blocking problems, "reject" if it is fundamentally flawed.`,
  ].join("\n");
}

export async function runCritic(
  input: CriticInput,
  llm: LLMProviderInterface,
): Promise<CriticSignal> {
  const schema = z.toJSONSchema(CriticVerdictSchema) as Record<string, unknown>;
  const reply = await llm.askStructured<unknown>(buildCriticPrompt(input), schema);
  const parsed = CriticVerdictSchema.safeParse(reply);
  if (!parsed.success) {
    throw new CriticError(`critic returned an invalid verdict: ${parsed.error.message}`, reply);
  }
  const { verdict, objections } = parsed.data;
  const blocking = objections.filter((o) => o.blocking).length;
  // Score derived here, never model-emitted — keeps it reproducible.
  const score = Math.max(0, VERDICT_SCORE[verdict] - blocking * BLOCKING_PENALTY);
  return { score, verdict, objections };
}

export async function critiquePlan(
  plan: IssuePlan,
  issue: PlanIssueInput,
  llm: LLMProviderInterface,
): Promise<CriticSignal> {
  return runCritic(
    {
      artifactKind: "plan",
      artifactLabel: `implementation plan for issue #${issue.number}: ${issue.title}`,
      artifact: JSON.stringify(plan, null, 2),
      context: [
        `Issue #${issue.number}: ${issue.title}`,
        issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
        issue.body ?? "(no issue body)",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    llm,
  );
}
