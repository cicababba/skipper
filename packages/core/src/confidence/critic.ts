import { z } from "zod";
import {
  displayKey,
  type CriticObjection,
  type CriticSignal,
  type CriticVerdict,
  type IssuePlan,
} from "@skipper/shared";
import type { LLMProviderInterface } from "../llm";
import type { PlanIssueInput } from "../planner";

// Adversarial critic primitive (issue #8). Artifact-agnostic on purpose:
// #10 remounts it on a diff ("artifactKind: diff") without touching this file.

/** Detail cap when priors are quoted back into the continuity prompt (#205). */
const MAX_OBJECTION_DETAIL_CHARS = 400;

/** Prior review round handed to a continuity critique (#205). */
export interface CriticPriorRound {
  objections: CriticObjection[];
  /** True when the coder was explicitly instructed to fix these (a fix round). */
  deliveredToCoder: boolean;
}

export interface CriticInput {
  artifactKind: "plan" | "diff";
  /** e.g. `implementation plan for issue #42`. */
  artifactLabel: string;
  /** Rendered plan JSON or unified diff. */
  artifact: string;
  /** Issue title + body + acceptance criteria. */
  context: string;
  /** Prior review round (#205); its presence switches on the continuity schema. */
  prior?: CriticPriorRound;
}

const CriticObjectionSchema = z.object({
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
});

export const CriticVerdictSchema = z.object({
  verdict: z.enum(["approve", "concerns", "reject"]),
  objections: z.array(CriticObjectionSchema),
});

/** Continuity variant (#205): objections carry a status, plus resolved P-labels. */
export const CriticContinuityVerdictSchema = z.object({
  verdict: z.enum(["approve", "concerns", "reject"]),
  objections: z.array(CriticObjectionSchema.extend({ status: z.enum(["new", "persisting"]) })),
  resolved: z.array(z.string()),
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

const BASE_VERDICT_INSTRUCTION = `Raise an objection ONLY for real, defensible problems; mark it blocking only when shipping as-is would be wrong. Verdict: "approve" if you failed to demolish it, "concerns" for non-blocking problems, "reject" if it is fundamentally flawed.`;

const CONTINUITY_INSTRUCTION = `For each objection you raise, set status: "persisting" when it re-raises one of the P1..Pn above that the current artifact still exhibits, otherwise "new". In "resolved", list the labels (e.g. "P2") of previous objections the current artifact genuinely fixed — not merely reworded. Never both resolve and re-raise the same prior objection, and do not re-raise a resolved objection just to acknowledge it.`;

function priorSection(prior: CriticPriorRound): string[] {
  const lines = [
    ``,
    `--- Previous review round ---`,
    prior.deliveredToCoder
      ? `The coder was specifically instructed to address these objections from the previous round:`
      : `These objections were raised in the previous round but were NOT explicitly handed to the coder:`,
  ];
  prior.objections.forEach((o, i) => {
    const detail =
      o.detail.length > MAX_OBJECTION_DETAIL_CHARS
        ? `${o.detail.slice(0, MAX_OBJECTION_DETAIL_CHARS)}…`
        : o.detail;
    lines.push(`P${i + 1}. [${o.kind}]${o.blocking ? " (blocking)" : ""} ${detail}`);
  });
  lines.push(`--- End previous review round ---`);
  return lines;
}

export function buildCriticPrompt(input: CriticInput): string {
  return [
    `You are an adversarial reviewer. Your job is to try to DEMOLISH the ${input.artifactKind} below — find every way it fails, misreads the issue, or would break the codebase. Do not be polite; be right.`,
    ``,
    `Artifact under review: ${input.artifactLabel}`,
    ``,
    `--- Context ---`,
    input.context,
    `--- End context ---`,
    ...(input.prior ? priorSection(input.prior) : []),
    ``,
    `--- ${input.artifactKind === "plan" ? "Plan" : "Diff"} ---`,
    input.artifact,
    `--- End ${input.artifactKind} ---`,
    ``,
    input.prior
      ? `${BASE_VERDICT_INSTRUCTION}\n\n${CONTINUITY_INSTRUCTION}`
      : BASE_VERDICT_INSTRUCTION,
  ].join("\n");
}

/** Map resolved P-labels back to prior objections (#205): tolerant first-digit
 *  parse, 1-based → index, bounds-checked and deduped; unmappable labels dropped. */
function mapResolvedLabels(labels: string[], prior: CriticObjection[]): CriticObjection[] {
  const seen = new Set<number>();
  const out: CriticObjection[] = [];
  for (const label of labels) {
    const match = /\d+/.exec(label);
    if (!match) continue;
    const idx = Number.parseInt(match[0], 10) - 1;
    if (idx < 0 || idx >= prior.length || seen.has(idx)) continue;
    seen.add(idx);
    out.push(prior[idx]);
  }
  return out;
}

export async function runCritic(
  input: CriticInput,
  llm: LLMProviderInterface,
  opts?: { cwd?: string; sessionId?: string; signal?: AbortSignal },
): Promise<CriticSignal> {
  if (input.prior) {
    const schema = z.toJSONSchema(CriticContinuityVerdictSchema) as Record<string, unknown>;
    const reply = await llm.askStructured<unknown>(buildCriticPrompt(input), schema, opts);
    const parsed = CriticContinuityVerdictSchema.safeParse(reply);
    if (!parsed.success) {
      throw new CriticError(`critic returned an invalid verdict: ${parsed.error.message}`, reply);
    }
    const { verdict, objections, resolved } = parsed.data;
    const blocking = objections.filter((o) => o.blocking).length;
    const score = Math.max(0, VERDICT_SCORE[verdict] - blocking * BLOCKING_PENALTY);
    return { score, verdict, objections, resolved: mapResolvedLabels(resolved, input.prior.objections) };
  }
  const schema = z.toJSONSchema(CriticVerdictSchema) as Record<string, unknown>;
  const reply = await llm.askStructured<unknown>(buildCriticPrompt(input), schema, opts);
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
  signal?: AbortSignal,
): Promise<CriticSignal> {
  return runCritic(
    {
      artifactKind: "plan",
      artifactLabel: `implementation plan for issue ${displayKey(issue.key)}: ${issue.title}`,
      artifact: JSON.stringify(plan, null, 2),
      context: [
        `Issue ${displayKey(issue.key)}: ${issue.title}`,
        issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
        issue.body ?? "(no issue body)",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    llm,
    signal ? { signal } : undefined,
  );
}
