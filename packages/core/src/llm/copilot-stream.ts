import type { CodingEvent } from "@skipper/shared";
import { createNdjsonFeeder, type NdjsonFeeder } from "./stream";

const SUMMARY_MAX = 2000;
const DETAIL_MAX = 120;
const INPUT_MAX = 2000;

// The copilot CLI's `--output-format json` event stream (#242). Unlike the
// claude and codex streams the schema is undocumented (github/copilot-cli#3551):
// the event *types* below come from community captures, the field names are
// educated guesses. Everything is therefore read through candidate-key helpers
// and every unknown shape maps to null — schema drift degrades to fewer console
// events, never a crash. First real Copilot run validates the guesses; a wrong
// field name is a one-line fix in the helper that names it.

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === "string" && v) return v;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function capInput(payload: Record<string, unknown>): string | undefined {
  if (Object.keys(payload).length === 0) return undefined;
  try {
    return JSON.stringify(payload, null, 2).slice(0, INPUT_MAX);
  } catch {
    return undefined;
  }
}

function toolUse(tool: string, detail: unknown, payload: Record<string, unknown>): CodingEvent {
  const full = capInput(payload);
  return {
    kind: "tool-use",
    tool,
    ...(typeof detail === "string" && detail ? { detail: detail.slice(0, DETAIL_MAX) } : {}),
    ...(full ? { input: full } : {}),
  };
}

/** The message text of an assistant line, wherever copilot puts it. */
function lineText(obj: Record<string, unknown>): string | undefined {
  const message = asRecord(obj.message);
  return firstString(obj.text, obj.content, message?.content, message?.text);
}

/** A session id carried by any line, wherever copilot puts it. */
export function lineSessionId(obj: Record<string, unknown>): string | undefined {
  const session = asRecord(obj.session);
  return firstString(obj.session_id, obj.sessionId, session?.id, session?.session_id);
}

function toolName(obj: Record<string, unknown>): string | undefined {
  const tool = asRecord(obj.tool);
  return firstString(obj.tool_name, obj.toolName, obj.name, obj.tool, tool?.name, tool?.id);
}

function toolArgs(obj: Record<string, unknown>): Record<string, unknown> {
  const tool = asRecord(obj.tool);
  return (
    asRecord(obj.arguments) ??
    asRecord(obj.args) ??
    asRecord(obj.input) ??
    asRecord(obj.parameters) ??
    asRecord(tool?.arguments) ??
    asRecord(tool?.args) ??
    {}
  );
}

function toolServer(obj: Record<string, unknown>): string | undefined {
  const tool = asRecord(obj.tool);
  return firstString(obj.server, obj.server_name, obj.mcp_server, tool?.server);
}

/**
 * Copilot's tool names to the console's claude-shaped vocabulary. The names are
 * unverified, so matching is by substring and anything unrecognized keeps its
 * raw name — a miss costs a less pretty console line, nothing more.
 */
function normalizeTool(
  name: string,
  args: Record<string, unknown>,
  server: string | undefined,
): { tool: string; detail?: unknown } {
  if (server) {
    // query/id carry the skipper-memory payloads — the get_memory id is the
    // ground truth for the "memories used" card (#46).
    const detail = firstString(args.query, args.id);
    return { tool: `mcp__${server}__${name}`, detail };
  }
  if (name.startsWith("mcp__")) return { tool: name, detail: firstString(args.query, args.id) };
  const lower = name.toLowerCase();
  const command = firstString(args.command, args.cmd, args.script);
  if (lower.includes("shell") || lower.includes("bash") || lower.includes("terminal")) {
    return { tool: "Bash", detail: command };
  }
  const path = firstString(args.path, args.file_path, args.filePath, args.file);
  if (lower.includes("edit") || lower.includes("patch") || lower.includes("replace")) {
    return { tool: "Edit", detail: path };
  }
  if (lower.includes("write") || lower.includes("create_file")) {
    return { tool: "Write", detail: path };
  }
  return { tool: name, detail: firstString(path, command, args.query, args.id) };
}

// Compaction, subagent, skill and hook lines are dropped whole: a failure in one
// of them is an internal detail of the run, not the run's own failure.
const SIDE_CHANNEL_LINE = /^(session|subagent|skill|hook)\./;

/** An error message when the line reports a failure, undefined otherwise. */
export function lineError(obj: Record<string, unknown>): string | undefined {
  const type = typeof obj.type === "string" ? obj.type : "";
  if (SIDE_CHANNEL_LINE.test(type)) return undefined;
  const error = asRecord(obj.error);
  const typed = /(^|[._])(error|failed|failure)$/.test(type);
  const message = firstString(
    typeof obj.error === "string" ? obj.error : undefined,
    error?.message,
    error?.error,
    typed ? firstString(obj.message, obj.reason) : undefined,
  );
  if (message) return message;
  if (typed || error !== undefined || obj.is_error === true) return "copilot reported an error";
  return undefined;
}

export function mapCopilotLine(line: unknown): CodingEvent | null {
  const obj = asRecord(line);
  if (!obj) return null;
  const type = typeof obj.type === "string" ? obj.type : "";

  // Full text arrives on assistant.message; the start/delta/reasoning lines
  // would only duplicate it in the console.
  if (type === "assistant.message") {
    const text = lineText(obj);
    return text && text.trim() ? { kind: "text", text } : null;
  }

  if (type === "tool.execution_start") {
    const name = toolName(obj);
    if (!name) return null;
    const args = toolArgs(obj);
    const { tool, detail } = normalizeTool(name, args, toolServer(obj));
    return toolUse(tool, detail, args);
  }

  const error = lineError(obj);
  if (error) return { kind: "error", message: error };

  return null;
}

/** Fields a `result` line overrides on the synthesized outcome (#242 D9). */
interface ResultOverrides {
  ok?: boolean;
  summary?: string;
  turns?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/** What a finished copilot run distilled to. Copilot does emit a terminal
 *  `result` line, but a crashed process may not — the outcome is synthesized
 *  from the stream either way and the result line only overrides it. */
export interface CopilotRunOutcome {
  event: Extract<CodingEvent, { kind: "result" }>;
  /** Full untruncated final agent message (the result event's summary is capped). */
  resultText?: string;
  /** The session id a later `copilot --resume` needs — pre-minted, or the
   *  stream-carried one when copilot reports a different id. */
  sessionId?: string;
  /** Set when the run aborted or the CLI reported an error. */
  failure?: string;
}

export interface CopilotRunAccumulator extends NdjsonFeeder {
  finish: () => CopilotRunOutcome;
}

function readUsage(source: Record<string, unknown> | undefined):
  | { inputTokens: number; outputTokens: number }
  | undefined {
  const usage = asRecord(source?.usage) ?? source;
  if (!usage) return undefined;
  const input = [usage.input_tokens, usage.inputTokens, usage.prompt_tokens].find(
    (v) => typeof v === "number",
  );
  const output = [usage.output_tokens, usage.outputTokens, usage.completion_tokens].find(
    (v) => typeof v === "number",
  );
  return typeof input === "number" && typeof output === "number"
    ? { inputTokens: input, outputTokens: output }
    : undefined;
}

/**
 * Feeds the copilot JSONL stream: forwards mapped events and accumulates the run
 * state (session id, last agent message, turn count, token usage, failure) the
 * terminal result event is built from. The agent-init event is synthesized on
 * the first parsed line, since copilot echoes no init line of its own — the
 * pre-minted session id is what the run was started with, and a stream-carried
 * id wins over it if one ever appears.
 */
export function createCopilotRunAccumulator(
  onEvent: (event: CodingEvent) => void,
  premintedSessionId?: string,
): CopilotRunAccumulator {
  let sessionId = premintedSessionId;
  let lastAgentMessage: string | undefined;
  let failure: string | undefined;
  let turns = 0;
  let sawUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let announcedInit = false;
  let overrides: ResultOverrides = {};

  const feeder = createNdjsonFeeder((line) => {
    const carried = lineSessionId(line);
    if (carried) sessionId = carried;
    if (!announcedInit && sessionId) {
      announcedInit = true;
      onEvent({ kind: "agent-init", sessionId });
    }

    const type = typeof line.type === "string" ? line.type : "";

    if (type === "result") {
      const usage = readUsage(line);
      const summary = firstString(line.result, lineText(line));
      overrides = {
        ...(typeof line.is_error === "boolean" || typeof line.success === "boolean"
          ? { ok: line.is_error === true ? false : line.success !== false }
          : {}),
        ...(summary ? { summary } : {}),
        ...(typeof line.num_turns === "number" ? { turns: line.num_turns } : {}),
        ...(usage ? { usage } : {}),
      };
      const error = lineError(line);
      if (error) failure = error;
      return;
    }

    if (type === "abort") {
      failure = firstString(line.reason, line.message) ?? "copilot run aborted";
      return;
    }

    if (type === "assistant.turn_end") {
      turns++;
      const usage = readUsage(line);
      if (usage) {
        sawUsage = true;
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
      }
      return;
    }

    // A failed tool is the agent's problem to recover from (tests fail, it fixes
    // them), never the run's outcome — only the usage is worth harvesting here.
    if (type === "tool.execution_complete") {
      const usage = readUsage(line);
      if (usage) {
        sawUsage = true;
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
      }
      return;
    }

    const event = mapCopilotLine(line);
    if (!event) return;
    if (event.kind === "text") lastAgentMessage = event.text;
    if (event.kind === "error") failure = event.message;
    onEvent(event);
  });

  return {
    feed: feeder.feed,
    flush: feeder.flush,
    finish() {
      const summary = overrides.summary ?? lastAgentMessage ?? failure;
      const usage = overrides.usage ?? (sawUsage ? { inputTokens, outputTokens } : undefined);
      return {
        event: {
          kind: "result",
          ok: (overrides.ok ?? true) && failure === undefined,
          ...(summary ? { summary: summary.slice(0, SUMMARY_MAX) } : {}),
          turns: overrides.turns ?? turns,
          ...(usage ? { usage } : {}),
        },
        ...(lastAgentMessage !== undefined ? { resultText: lastAgentMessage } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(failure !== undefined ? { failure } : {}),
      };
    },
  };
}
