import { AGENT_MAX_TURNS_BACKSTOP, type CodingEvent, type IssuePlan } from "@skipper/shared";
import type { IssueComment } from "../adapters/types";
import type { LLMProviderInterface, LLMResponse } from "../llm/provider";
import { AgentAbortError } from "../llm/provider";
import type { MemoryMcp } from "../llm/memory-mcp";
import { renderGraphifySection, type GraphifyContext } from "../llm/graphify-mcp";
import type { RunConfinement } from "../llm/confinement";
import { isSalvageableDeath } from "../llm/claude-cli";
import { withRepoConventions } from "../instructions";
import { parseJsonReply } from "../llm/json";
import { IssuePlanSchema, planJsonSchema } from "./schema";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerPrompt,
  buildRepairPrompt,
  buildSalvagePrompt,
} from "./prompt";

const SALVAGE_MAX_TURNS = 4;
/** Wall-clock cap for the salvage wrap-up run — it must not explore, only emit (#194). */
const SALVAGE_HARD_TIMEOUT_MS = 5 * 60_000;

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
  /** Wall-clock budget for the primary run (#194); on expiry the salvage path
   *  resumes the on-disk session for a short plan-emitting wrap-up. */
  hardTimeoutMs?: number;
  /** Streams progress from the primary agent run only (repair round stays silent). */
  onEvent?: (event: CodingEvent) => void;
  /** Inject the skipper-memory MCP server, scoped to the item's repo (#45). */
  memory?: MemoryMcp;
  /** Persist the primary agent run under this session id (#111); the repair round stays stateless. */
  sessionId?: string;
  /** Abort the run; rejects with AgentAbortError. claude-cli only (#159). */
  signal?: AbortSignal;
  /** Keep the run inside its cwd (#196); passed only when cwd is the worktree. */
  confinement?: RunConfinement;
  /** Raw `git status --porcelain` lines for pre-existing uncommitted changes in the
   *  worktree, left by a prior coding attempt — surfaced in the prompt so the plan
   *  accounts for them (#202). */
  preexistingChanges?: string[];
  /** The repo's Skipper-owned agent-instructions doc content (#227), appended to
   *  the planner system prompt as a "Repository conventions" section. */
  repoInstructions?: string;
  /** The repo's Graphify knowledge-graph index (#233): attaches the graphify MCP
   *  server and appends a section declaring the graph exists. */
  graphify?: GraphifyContext;
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
  signal?: AbortSignal,
): Promise<IssuePlan> {
  const first = tryParsePlan(raw);
  if (first.ok) return first.plan;

  const repaired = await llm.askStructured<unknown>(
    buildRepairPrompt(raw, first.error),
    planJsonSchema(),
    signal ? { signal } : undefined,
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
  if (opts.signal?.aborted) throw new AgentAbortError();
  const schema = planJsonSchema();
  const systemPrompt =
    withRepoConventions(PLANNER_SYSTEM_PROMPT, opts.repoInstructions) +
    (opts.graphify ? `\n\n${renderGraphifySection(opts.graphify)}` : "");
  let reply: LLMResponse;
  try {
    reply = await opts.llm.agent(buildPlannerPrompt(opts.issue, schema, opts.preexistingChanges), {
      systemPrompt,
      cwd: opts.repoPath,
      maxTurns: opts.maxTurns ?? AGENT_MAX_TURNS_BACKSTOP,
      ...(opts.hardTimeoutMs !== undefined ? { hardTimeoutMs: opts.hardTimeoutMs } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.graphify ? { graph: opts.graphify.mcp } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.confinement ? { confinement: opts.confinement } : {}),
    });
  } catch (err) {
    // AgentAbortError is not a ClaudeCliError, so an aborted primary run rethrows
    // here without touching the salvage path (#159). A budget/turns death with an
    // on-disk session resumes for a short wrap-up that emits the plan (#194).
    if (!isSalvageableDeath(err) || !opts.sessionId) {
      throw err;
    }
    try {
      reply = await opts.llm.agent(buildSalvagePrompt(schema), {
        systemPrompt,
        cwd: opts.repoPath,
        maxTurns: SALVAGE_MAX_TURNS,
        hardTimeoutMs: SALVAGE_HARD_TIMEOUT_MS,
        resumeSessionId: opts.sessionId,
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.confinement ? { confinement: opts.confinement } : {}),
      });
    } catch {
      // Salvage also died — surface the ORIGINAL death (its honest budget message).
      throw err;
    }
  }

  return validatePlanReply(opts.llm, reply.text, opts.signal);
}
