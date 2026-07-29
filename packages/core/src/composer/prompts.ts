import { isPlanChatText } from "@skipper/shared";
import type {
  ComposerDraft,
  ComposerEditedFlags,
  ComposerRelation,
  PlanChatMessage,
} from "@skipper/shared";
import { renderGraphifySection, type GraphifyContext } from "../llm/graphify-mcp";
import { withRepoConventions } from "../instructions";

// Chat composer prompts (#136): the intake-side counterpart of the coder chat.
// The agent runs in the user's own checkout with a read-leaning toolset and
// shapes a conversation into well-scoped issues for this repository.

export const COMPOSER_SYSTEM_PROMPT = `You are a senior engineer on this repository, helping the user turn an idea into well-scoped issues for its tracker.

Answer conversationally in markdown. Your current working directory is the user's checkout of the repository — use Read, Grep, Glob and read-only Bash to ground every claim in real files, symbols and conventions, and cite the paths you looked at. Never speculate about code you have not opened. Do NOT modify any file, including via Bash.

Ask about the parts of the request that are genuinely ambiguous, and propose a split into several issues when the scope demands it — one issue per independently shippable, reviewable change. Follow the repository's own issue conventions (title format, labels, structure) when it has any. Do not emit the issue draft until the user explicitly asks for it.`;

const RELATION_LABELS: Record<ComposerRelation["kind"], string> = {
  blocks: "blocks",
  "part-of": "part of",
  "relates-to": "relates to",
};

/** The composer's system prompt for one repo: conventions doc + graph section. */
export function buildComposerSystemPrompt(opts: {
  repoInstructions?: string;
  graphify?: GraphifyContext;
}): string {
  return (
    withRepoConventions(COMPOSER_SYSTEM_PROMPT, opts.repoInstructions) +
    (opts.graphify ? `\n\n${renderGraphifySection(opts.graphify)}` : "")
  );
}

const EDIT_MARKER = "[edited by user — preserve verbatim unless the user asks otherwise]";

function editedFields(edited: ComposerEditedFlags | undefined, index: number): string[] {
  return edited?.[index] ?? [];
}

function marked(field: string, fields: string[]): string {
  return fields.includes(field) ? ` ${EDIT_MARKER}` : "";
}

/** The current draft as a prompt block, with per-field markers for the fields
 *  the user hand-edited (#136 keeps preservation prompt-level, not mechanical). */
export function renderDraftBlock(draft: ComposerDraft, edited?: ComposerEditedFlags): string {
  const lines: string[] = ["--- Current draft ---"];
  draft.issues.forEach((issue, i) => {
    const fields = editedFields(edited, i);
    lines.push(`Issue ${i + 1}`);
    lines.push(`Title:${marked("title", fields)} ${issue.title}`);
    lines.push(`Body:${marked("body", fields)}`);
    lines.push(issue.body || "(empty)");
    lines.push(
      `Acceptance criteria:${marked("acceptanceCriteria", fields)} ${
        issue.acceptanceCriteria.length > 0
          ? `\n${issue.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
          : "none"
      }`,
    );
    lines.push(
      `Labels:${marked("labels", fields)} ${issue.labels.length > 0 ? issue.labels.join(", ") : "none"}`,
    );
    lines.push("");
  });
  if (draft.relations.length > 0) {
    lines.push("Relations:");
    for (const r of draft.relations) {
      lines.push(`- Issue ${r.from + 1} ${RELATION_LABELS[r.kind]} issue ${r.to + 1}`);
    }
  }
  lines.push("--- End current draft ---");
  return lines.join("\n");
}

function renderHistory(history: PlanChatMessage[]): string {
  return history
    .filter(isPlanChatText)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
}

function draftLines(draft?: ComposerDraft, edited?: ComposerEditedFlags): string[] {
  if (!draft) return [];
  return [
    ``,
    `A draft has already been generated from this discussion — the user may have edited it since:`,
    renderDraftBlock(draft, edited),
  ];
}

export function buildComposerResumePrompt(opts: {
  message: string;
  draft?: ComposerDraft;
  edited?: ComposerEditedFlags;
}): string {
  return [
    `The user is continuing the discussion about the issues to open on this repository.`,
    `Answer conversationally, grounded in the code. Do NOT modify any file and do NOT emit the issue draft unless the user asks for it.`,
    ...draftLines(opts.draft, opts.edited),
    ``,
    `User: ${opts.message}`,
  ].join("\n");
}

export function buildComposerFallbackPrompt(opts: {
  message: string;
  history: PlanChatMessage[];
  draft?: ComposerDraft;
  edited?: ComposerEditedFlags;
}): string {
  const history = renderHistory(opts.history);
  return [
    `You are helping the user shape work into well-scoped issues for the repository at your current working directory. Answer the latest message conversationally in markdown, grounded in the code. Do NOT modify any file and do NOT emit the issue draft unless the user asks for it.`,
    ...(history ? [``, `--- Conversation so far ---`, history, `--- End conversation ---`] : []),
    ...draftLines(opts.draft, opts.edited),
    ``,
    `User: ${opts.message}`,
  ].join("\n");
}
