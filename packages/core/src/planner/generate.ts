import type { CodingEvent, IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface } from "../llm/provider";
import type { MemoryMcp } from "../llm/memory-mcp";
import { parseJsonReply } from "../llm/json";
import { IssuePlanSchema, planJsonSchema } from "./schema";
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt, buildRepairPrompt } from "./prompt";

export interface PlanIssueInput {
  number: number;
  title: string;
  url: string;
  labels: string[];
  body?: string;
}

export interface GeneratePlanOptions {
  issue: PlanIssueInput;
  /** Local checkout the agent explores (cwd). */
  repoPath: string;
  llm: LLMProviderInterface;
  maxTurns?: number;
  /** Streams progress from the primary agent run only (repair round stays silent). */
  onEvent?: (event: CodingEvent) => void;
  /** Inject the skipper-memory MCP server, scoped to the item's repo (#45). */
  memory?: MemoryMcp;
}

export class PlanGenerationError extends Error {
  readonly raw?: string;

  constructor(message: string, raw?: string) {
    super(message);
    this.name = "PlanGenerationError";
    this.raw = raw;
  }
}

function summarizeZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function tryParsePlan(text: string): { ok: true; plan: IssuePlan } | { ok: false; error: string } {
  let candidate: unknown;
  try {
    candidate = parseJsonReply<unknown>(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = IssuePlanSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, plan: parsed.data };
  return { ok: false, error: summarizeZodError(parsed.error) };
}

/**
 * Generate one structured implementation plan by letting the agent explore
 * the repo, then validating its final JSON reply. One cheap repair round via
 * askStructured covers format slips without re-exploring. Pure and callable
 * N times — #8's convergence signal builds on that.
 */
export async function generatePlan(opts: GeneratePlanOptions): Promise<IssuePlan> {
  if (!opts.llm.agent) {
    throw new PlanGenerationError(`LLM provider "${opts.llm.name}" does not support agent mode`);
  }
  const schema = planJsonSchema();
  const reply = await opts.llm.agent(buildPlannerPrompt(opts.issue, schema), {
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    cwd: opts.repoPath,
    maxTurns: opts.maxTurns ?? 24,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
  });

  const first = tryParsePlan(reply.text);
  if (first.ok) return first.plan;

  const repaired = await opts.llm.askStructured<unknown>(
    buildRepairPrompt(reply.text, first.error),
    schema,
  );
  const second = IssuePlanSchema.safeParse(repaired);
  if (second.success) return second.data;

  throw new PlanGenerationError(
    `plan failed schema validation: ${summarizeZodError(second.error)}`,
    reply.text,
  );
}
