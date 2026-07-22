import { displayKey } from "@skipper/shared";
import type { IssueComment } from "../adapters/types";
import type { PlanIssueInput } from "./generate";

const MAX_BODY_CHARS = 20_000;

const MAX_COMMENTS = 30;
const MAX_COMMENTS_TOTAL_CHARS = 15_000;
const MAX_COMMENT_CHARS = 4_000;

/** Render an issue's comments (ascending chronological) as one prompt block, or
 *  undefined when there are none. Caps: last 30 comments, 4k chars per comment,
 *  15k total dropping oldest first, newest always kept. Never throws (#144). */
export function renderCommentsBlock(comments: IssueComment[] | undefined): string | undefined {
  if (!comments || comments.length === 0) return undefined;
  const recent = comments.slice(-MAX_COMMENTS);
  let omitted = comments.length - recent.length;

  const renderEntry = (c: IssueComment): string => {
    const body =
      c.body.length > MAX_COMMENT_CHARS
        ? `${c.body.slice(0, MAX_COMMENT_CHARS)}\n[... comment truncated ...]`
        : c.body;
    return `${c.author} (${c.createdAt}):\n${body}`;
  };

  // Walk newest→oldest within the total budget; always keep the newest.
  const kept: string[] = [];
  let total = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = renderEntry(recent[i]);
    if (kept.length > 0 && total + entry.length > MAX_COMMENTS_TOTAL_CHARS) {
      omitted += i + 1;
      break;
    }
    kept.push(entry);
    total += entry.length;
  }
  kept.reverse();

  const lines = ["--- Issue comments (newest last) ---"];
  if (omitted > 0) {
    lines.push(`[... ${omitted} earlier comment${omitted === 1 ? "" : "s"} omitted ...]`);
  }
  lines.push(kept.join("\n\n"));
  lines.push("--- End issue comments ---");
  return lines.join("\n");
}

export const PLANNER_SYSTEM_PROMPT = `You are a senior software engineer preparing an implementation plan for a GitHub issue in the repository at your current working directory.

Operate ONLY inside your current working directory and never modify any files anywhere, including via Bash — even if the issue mentions absolute paths elsewhere on this machine. You are only writing a plan, not code.

Explore the repository with Read, Grep and Glob BEFORE planning. Every file path and every symbol (function, class, export) you cite MUST exist in the repository — never invent paths or symbols. Cite repo-relative paths. Files the plan will CREATE must be listed with "status": "new"; every path without it (or with "status": "existing") must already exist. Symbols a step will CREATE (functions/classes/exports that don't exist yet) go in that step's "createdSymbols", never in "symbols"; "symbols" is only for symbols that already exist in the repository.

When the skipper-memory tools are available, before planning call search_memory with a short description of this issue to find similar solved issues in this repo, and get_memory(id) for the full plan + diff of a promising hit — let the established approach and conventions inform your plan.

Derive acceptance criteria from the issue body when they are not explicit. List openQuestions only when the issue is genuinely ambiguous; otherwise return an empty array.

Also populate these fields (each may be an empty array when nothing applies):
- context: facts you VERIFIED during repo exploration — gotchas, patterns to follow, invariants — with file:line where useful. Not a paraphrase of the issue.
- outOfScope: what must NOT be touched, derived from the issue plus your judgment.
- verificationCommands: REAL commands found in the repo (e.g. package.json scripts), never invented ones.
- manualChecks: manual verification steps a human should run.

You have a limited budget of agent turns for this task. Batch independent tool calls in ONE message — several Grep/Glob/Read calls at once — instead of one call per turn. Prefer targeted greps over reading whole files. Once you have learned enough to write a correct plan, stop exploring and emit the plan.`;

export function buildSalvagePrompt(schema: Record<string, unknown>): string {
  return [
    `You ran out of your exploration budget (time or tool calls) while exploring. Do NOT call any more tools. Using only what you have already learned in this session, reply NOW with the implementation-plan JSON. Reply with ONLY the JSON, no prose. Schema: ${JSON.stringify(schema)}`,
    ``,
    `For any file you did not verify, either omit it or surface the uncertainty in openQuestions/risks — never invent paths or symbols.`,
  ].join("\n");
}

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
    `Issue ${displayKey(issue.key)}: ${issue.title}`,
    `URL: ${issue.url}`,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
    ``,
    body ? `--- Issue body ---\n${body}\n--- End issue body ---` : `(The issue has no body.)`,
    ``,
    renderCommentsBlock(issue.comments) ?? "",
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
