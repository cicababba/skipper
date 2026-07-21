import type { CodingEvent, IssuePlan } from "@skipper/shared";
import type { IssueComment } from "../adapters/types";
import type { LLMProviderInterface } from "../llm/provider";
import type { MemoryMcp } from "../llm/memory-mcp";
import { parseJsonReply } from "../llm/json";
import { IssuePlanSchema, planJsonSchema } from "./schema";
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt, buildRepairPrompt } from "./prompt";

export interface PlanIssueInput {
  /** Work-item display key: "42" (GitHub) or "PROJ-123" (Jira). */
  key: string;
  title: string;
  url: string;
  labels: string[];
  body?: string;
  /** Issue comments in ascending chronological order, fetched at plan/code time (#144). */
  comments?: IssueComment[];
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
  /** Persist the primary agent run under this session id (#111); the repair round stays stateless. */
  sessionId?: string;
}

export class PlanGenerationError extends Error {
  readonly raw?: string;

  constructor(message: string, raw?: string) {
    super(message);
    this.name = "PlanGenerationError";
    this.raw = raw;
  }
}

export function summarizeZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
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
 * Validate an agent's final JSON reply against the plan schema, with one cheap
 * askStructured repair round for format slips. Shared by generatePlan and the
 * conversational plan-review apply flow (#145).
 */
export async function validatePlanReply(
  llm: LLMProviderInterface,
  raw: string,
): Promise<IssuePlan> {
  const first = tryParsePlan(raw);
  if (first.ok) return first.plan;

  const repaired = await llm.askStructured<unknown>(
    buildRepairPrompt(raw, first.error),
    planJsonSchema(),
  );
  const second = IssuePlanSchema.safeParse(repaired);
  if (second.success) return second.data;

  throw new PlanGenerationError(
    `plan failed schema validation: ${summarizeZodError(second.error)}`,
    raw,
  );
}

/**
 * Generate one structured implementation plan by letting the agent explore
 * the repo, then validating its final JSON reply. One cheap repair round via
 * askStructured covers format slips without re-exploring. Pure and callable
 * N times — #8's convergence signal builds on that.
 */
export async function generatePlan(opts: GeneratePlanOptions): Promise<IssuePlan> {
  if (!opts.llm.agent) {
    throw new PlanGenerationError(
      `planning needs a provider with agent mode (claude-cli or ollama) — "${opts.llm.name}" has none. Pick one in Settings.`,
    );
  }
  const schema = planJsonSchema();
  const reply = await opts.llm.agent(buildPlannerPrompt(opts.issue, schema), {
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    cwd: opts.repoPath,
    maxTurns: opts.maxTurns ?? 24,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });

  return validatePlanReply(opts.llm, reply.text);
}
