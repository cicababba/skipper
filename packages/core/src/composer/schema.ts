import { z } from "zod";
import type { ComposerDraft } from "@skipper/shared";
import { summarizeZodError } from "../planner/generate";

// Composer draft schema (#136). Zod-first like the planner: one declaration
// backs both the JSON Schema handed to the agent and the runtime validation of
// its reply.

export const composerDraftSchema = z.object({
  issues: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string(),
        acceptanceCriteria: z.array(z.string()),
        labels: z.array(z.string()),
      }),
    )
    .min(1),
  relations: z.array(
    z.object({
      from: z.number().int().min(0),
      to: z.number().int().min(0),
      kind: z.enum(["blocks", "part-of", "relates-to"]),
    }),
  ),
}) satisfies z.ZodType<ComposerDraft>;

export const COMPOSER_DRAFT_JSON_SCHEMA = z.toJSONSchema(composerDraftSchema) as Record<
  string,
  unknown
>;

/**
 * Validate a candidate draft, normalizing what a model reliably gets slightly
 * wrong: titles come back padded, and relations point at issues that the model
 * dropped between one revision and the next. Out-of-range and self-referential
 * relations are silently discarded rather than failing the whole draft.
 */
export function validateComposerDraft(
  value: unknown,
): { ok: true; draft: ComposerDraft } | { ok: false; error: string } {
  const parsed = composerDraftSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: summarizeZodError(parsed.error) };
  const issues = parsed.data.issues.map((i) => ({ ...i, title: i.title.trim() }));
  const relations = parsed.data.relations.filter(
    (r) => r.from !== r.to && r.from < issues.length && r.to < issues.length,
  );
  return { ok: true, draft: { issues, relations } };
}
