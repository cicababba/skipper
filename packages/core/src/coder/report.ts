import { z } from "zod";
import type { CoderReport } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import { parseJsonReply } from "../llm/json";
import { buildRepairPrompt } from "../planner/prompt";
import { summarizeZodError } from "../planner/generate";

// Structured coder report (#146): the coding run's final JSON message. Mirrors
// the planner's schema + parse→repair→degrade ladder, but the try and repair
// steps are split so the happy path never constructs a provider.

export const CoderReportSchema = z.object({
  done: z.array(
    z.object({
      path: z.string().min(1),
      summary: z.string(),
    }),
  ),
  deviations: z.array(z.string()),
  verification: z.array(
    z.object({
      command: z.string().min(1),
      passed: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
  open: z.array(z.string()),
}) satisfies z.ZodType<CoderReport>;

export function coderReportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(CoderReportSchema) as Record<string, unknown>;
}

export class CoderReportParseError extends Error {
  readonly raw?: string;

  constructor(message: string, raw?: string) {
    super(message);
    this.name = "CoderReportParseError";
    this.raw = raw;
  }
}

/** "None"/"none." placeholder entries collapse to nothing (#146). */
function normalize(report: CoderReport): CoderReport {
  const dropNone = (list: string[]) => list.filter((e) => !/^none\.?$/i.test(e.trim()));
  return {
    ...report,
    deviations: dropNone(report.deviations),
    open: dropNone(report.open),
  };
}

export function tryParseCoderReport(
  text: string,
): { ok: true; report: CoderReport } | { ok: false; error: string } {
  let candidate: unknown;
  try {
    candidate = parseJsonReply<unknown>(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = CoderReportSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, report: normalize(parsed.data) };
  return { ok: false, error: summarizeZodError(parsed.error) };
}

/**
 * One askStructured repair round for a coder report the deterministic ladder
 * could not recover. Split from tryParseCoderReport so the happy path stays
 * provider-free. Throws CoderReportParseError (carrying the raw text) on a
 * second failure.
 */
export async function repairCoderReport(
  llm: LLMProviderInterface,
  raw: string,
  parseError: string,
): Promise<CoderReport> {
  const repaired = await llm.askStructured<unknown>(
    buildRepairPrompt(raw, parseError),
    coderReportJsonSchema(),
  );
  const parsed = CoderReportSchema.safeParse(repaired);
  if (parsed.success) return normalize(parsed.data);
  throw new CoderReportParseError(
    `coder report failed schema validation: ${summarizeZodError(parsed.error)}`,
    raw,
  );
}

/** Shared prompt tail appended to every coder builder (#146). */
export function reportContractBlock(): string {
  return [
    `--`,
    `Your FINAL message must be ONLY a single JSON object matching this JSON Schema. No prose, no code fences, no preamble.`,
    `- done: one entry per file you changed — its repo-relative path and a one-line summary of the change.`,
    `- deviations: every place you diverged from the plan and why. Empty array if you followed the plan exactly.`,
    `- verification: each command you ran to verify the work, with its outcome (passed) and any relevant detail.`,
    `- open: unresolved conflicts, questions, or plan steps you deliberately skipped. Empty array if none.`,
    ``,
    `Schema:`,
    JSON.stringify(coderReportJsonSchema()),
  ].join("\n");
}
