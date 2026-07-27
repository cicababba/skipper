// Lesson distillation (#256): a captured solution is a plan plus a diff plus a
// pile of review rounds — the reusable part is none of those, it's the lesson
// hiding in them. One single-shot structured call turns the record into
// problem + insight + gotchas, which then rides along in the embedded text.
// Runtime-agnostic by construction: it only needs AgentRuntime.structured.

import type { ReviewRound } from "@skipper/shared";
import type { AgentRuntime } from "../runtime/types";

/** Single-shot summarization budget — the knowledge extractor's, not the reviewer's
 *  agentic 120k: there is no exploration here, only one prompt. */
export const DISTILL_DIFF_BUDGET = 60_000;
/** Review rounds are dropped oldest-first: the late rounds hold the lessons. */
export const DISTILL_REVIEW_BUDGET = 10_000;

export interface DistillInput {
  title: string;
  planSummary?: string;
  planSteps?: string[];
  diff?: string;
  reviewRounds?: ReviewRound[];
}

export interface Lesson {
  problem: string;
  insight: string;
  gotchas?: string[];
}

export const LESSON_SCHEMA = {
  type: "object",
  properties: {
    problem: {
      type: "string",
      description: "What was actually being solved, in one or two concrete sentences.",
    },
    insight: {
      type: "string",
      description:
        "The approach that worked and why — the reusable part. Name the files, seams or constraints that mattered.",
    },
    gotchas: {
      type: "array",
      items: { type: "string" },
      description: "Non-obvious traps this work uncovered. Omit when there were none.",
    },
  },
  required: ["problem", "insight"],
};

const SYSTEM_PROMPT = `You are Skipper's memory distiller. You read the record of one completed issue — the plan that was executed, the merged diff, and the agent review rounds — and write the LESSON worth recalling the next time a similar problem appears in this repo.

Write for a coding agent that will read this months from now with no other context:
- problem: the concrete situation that was being solved, not a restatement of the issue title.
- insight: the approach that worked and why it worked — the reusable part. Name the files, seams and constraints that mattered.
- gotchas: non-obvious traps this work uncovered — review objections that had to be fixed, wrong turns, hidden coupling. Omit the field entirely when there were none.

Be specific and short. No preamble, no narration of the diff, no praise. Never invent detail the material does not support.

You MUST output JSON matching the schema. No prose outside the JSON.`;

function truncateTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n…[truncated — ${text.length} characters total]…`;
}

function renderReviewRound(round: ReviewRound): string {
  const lines = [`Round ${round.round}: ${round.outcome}${round.reason ? ` — ${round.reason}` : ""}`];
  for (const objection of round.objections ?? []) {
    lines.push(`  - [${objection.kind}] ${objection.detail}`);
  }
  for (const resolved of round.resolvedObjections ?? []) {
    lines.push(`  - resolved: ${resolved.detail}`);
  }
  return lines.join("\n");
}

/** Newest rounds first into the budget, then re-ordered oldest-first for reading. */
function renderReviewRounds(rounds: ReviewRound[]): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const text = renderReviewRound(rounds[i]);
    if (used + text.length > DISTILL_REVIEW_BUDGET) break;
    kept.unshift(text);
    used += text.length + 1;
  }
  return kept.join("\n");
}

export function buildDistillPrompt(input: DistillInput): string {
  const sections = [SYSTEM_PROMPT, "", `Issue: ${input.title}`];
  if (input.planSummary) sections.push("", "Plan summary:", input.planSummary);
  if (input.planSteps && input.planSteps.length > 0) {
    sections.push("", "Plan steps:", ...input.planSteps.map((s) => `- ${s}`));
  }
  const rounds = input.reviewRounds ? renderReviewRounds(input.reviewRounds) : "";
  if (rounds) sections.push("", "Agent review rounds:", rounds);
  if (input.diff) sections.push("", "Merged diff:", truncateTail(input.diff, DISTILL_DIFF_BUDGET));
  return sections.join("\n");
}

export function formatLesson(lesson: Lesson): string {
  const parts = [`Problem: ${lesson.problem.trim()}`, `Insight: ${lesson.insight.trim()}`];
  const gotchas = (lesson.gotchas ?? []).map((g) => g.trim()).filter(Boolean);
  if (gotchas.length > 0) {
    parts.push(["Gotchas:", ...gotchas.map((g) => `- ${g}`)].join("\n"));
  }
  return parts.join("\n");
}

/**
 * One structured call, no tools, one turn. Returns null when the runtime answers
 * without the two required fields — a lesson-less record is better than a fake one.
 */
export async function distillLesson(
  runtime: AgentRuntime,
  input: DistillInput,
): Promise<string | null> {
  const lesson = await runtime.structured<Lesson>(buildDistillPrompt(input), LESSON_SCHEMA, {
    tools: "",
  });
  if (!lesson?.problem?.trim() || !lesson?.insight?.trim()) return null;
  return formatLesson(lesson);
}
