import type { ClaritySignal, IssuePlan } from "@skipper/shared";

const ACCEPTANCE_RE = /(^|\n)\s*(-\s*\[[ x]\]|acceptance criteria|acceptance:|\bAC:|expected behav)/i;
const REPRO_RE = /(steps to reproduce|how to reproduce|\brepro\b|reproduction)/i;
const MIN_BODY_CHARS = 80;

export function scoreClarity(issueBody: string | undefined, plan: IssuePlan): ClaritySignal {
  const body = issueBody?.trim() ?? "";
  const bodyPresent = body.length > MIN_BODY_CHARS;
  const hasAcceptanceCriteria = ACCEPTANCE_RE.test(body);
  const hasReproSteps = REPRO_RE.test(body);
  const openQuestionCount = plan.openQuestions.length;
  const score = clamp01(
    0.5 +
      (hasAcceptanceCriteria ? 0.2 : 0) +
      (hasReproSteps ? 0.15 : 0) +
      (bodyPresent ? 0.15 : 0) -
      openQuestionCount * 0.1,
  );
  return { score, bodyPresent, hasAcceptanceCriteria, hasReproSteps, openQuestionCount };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
