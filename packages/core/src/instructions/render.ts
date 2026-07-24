// Injects a repo's agent-instructions doc (#227) into a base system prompt as a
// capped "Repository conventions" section. Agentic runs pass --setting-sources
// "" so the planner/coder never see the repo's CLAUDE.md directly; this is how
// the Skipper-owned conventions doc reaches them.

/** Char budget for the injected conventions section — truncated past this. */
export const REPO_CONVENTIONS_CHAR_BUDGET = 16_000;

/**
 * Render the "## Repository conventions" section for the doc content, or
 * undefined when there is nothing to inject (undefined / empty / whitespace).
 * Truncated at budget with a marker, mirroring truncateDiff.
 */
export function renderRepoConventions(
  content?: string,
  budget = REPO_CONVENTIONS_CHAR_BUDGET,
): string | undefined {
  const trimmed = content?.trim();
  if (!trimmed) return undefined;
  const body =
    trimmed.length > budget
      ? `${trimmed.slice(0, budget)}\n[repository conventions truncated — showing first ${budget} of ${trimmed.length} characters]`
      : trimmed;
  return `## Repository conventions\n${body}`;
}

/**
 * Append the conventions section to a base system prompt. Returns the base
 * unchanged when there is nothing to inject.
 */
export function withRepoConventions(
  base: string,
  content?: string,
  budget = REPO_CONVENTIONS_CHAR_BUDGET,
): string {
  const section = renderRepoConventions(content, budget);
  return section ? `${base}\n\n${section}` : base;
}
