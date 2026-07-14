import type { PlanIssueInput } from "./generate";

const MAX_BODY_CHARS = 20_000;

export const PLANNER_SYSTEM_PROMPT = `You are a senior software engineer preparing an implementation plan for a GitHub issue in the repository at your current working directory.

Explore the repository with Read, Grep and Glob BEFORE planning. Every file path and every symbol (function, class, export) you cite MUST exist in the repository — never invent paths or symbols. Cite repo-relative paths. Files the plan will CREATE must be listed with "status": "new"; every path without it (or with "status": "existing") must already exist.

When the skipper-memory tools are available, before planning call search_memory with a short description of this issue to find similar solved issues in this repo, and get_memory(id) for the full plan + diff of a promising hit — let the established approach and conventions inform your plan.

Derive acceptance criteria from the issue body when they are not explicit. List openQuestions only when the issue is genuinely ambiguous; otherwise return an empty array.`;

export function buildPlannerPrompt(
  issue: PlanIssueInput,
  schema: Record<string, unknown>,
): string {
  const body =
    issue.body && issue.body.length > MAX_BODY_CHARS
      ? `${issue.body.slice(0, MAX_BODY_CHARS)}\n[... issue body truncated ...]`
      : issue.body;
  const lines = [
    `Plan the implementation of this GitHub issue.`,
    ``,
    `Issue #${issue.number}: ${issue.title}`,
    `URL: ${issue.url}`,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
    ``,
    body ? `--- Issue body ---\n${body}\n--- End issue body ---` : `(The issue has no body.)`,
    ``,
    `--`,
    `Your FINAL message must be ONLY a single JSON object matching this JSON Schema. No prose, no code fences, no preamble.`,
    ``,
    `Schema:`,
    JSON.stringify(schema),
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function buildRepairPrompt(raw: string, validationErrors: string): string {
  return [
    `The following text was supposed to be a single JSON object matching the schema, but it is invalid.`,
    ``,
    `Validation errors:`,
    validationErrors,
    ``,
    `--- Original text ---`,
    raw,
    `--- End original text ---`,
    ``,
    `Produce the corrected JSON object. Preserve the original content wherever it is valid; fix only what the schema requires.`,
  ].join("\n");
}
