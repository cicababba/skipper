import type { CodingEvent } from "@skipper/shared";
import { createNdjsonFeeder, type NdjsonFeeder } from "./stream";

const SUMMARY_MAX = 2000;
const DETAIL_MAX = 120;
const INPUT_MAX = 2000;

// The gemini CLI's `--output-format stream-json` event stream (#243). The shapes
// below come from the documented JsonStreamEvent union in the CLI source, not
// from a live capture (#243 D2):
//   {"type":"init","session_id":"…","model":"…"}
//   {"type":"message","role":"assistant","content":"…","delta":"…"}
//   {"type":"tool_use","tool_name":"run_shell_command","tool_id":"…","parameters":{…}}
//   {"type":"tool_result","tool_id":"…","status":"success"}
//   {"type":"error","severity":"error","message":"…"}
//   {"type":"result","status":"success","stats":{"input_tokens":…,"output_tokens":…}}
// Tolerant like mapCopilotLine: unknown types and malformed lines map to null, so
// schema drift degrades to fewer console events, never a crash.

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

/**
 * Gemini's built-in tool names to the console's claude-shaped vocabulary. An MCP
 * tool arrives as `mcp_<server>_<tool>`, which becomes the `mcp__server__tool`
 * form the "memories used" card reads (#46). Unknown names pass through — a miss
 * costs a less pretty console line, nothing more.
 */
function normalizeTool(
  name: string,
  args: Record<string, unknown>,
): { tool: string; detail?: unknown } {
  const memoryDetail = firstString(args.query, args.id);
  if (name.startsWith("mcp__")) return { tool: name, detail: memoryDetail };
  if (name.startsWith("mcp_")) {
    const rest = name.slice("mcp_".length);
    const sep = rest.indexOf("_");
    if (sep > 0) {
      return {
        tool: `mcp__${rest.slice(0, sep)}__${rest.slice(sep + 1)}`,
        detail: memoryDetail,
      };
    }
  }
  const path = firstString(args.file_path, args.path, args.absolute_path);
  switch (name) {
    case "run_shell_command":
      return { tool: "Bash", detail: firstString(args.command) };
    case "write_file":
    case "replace":
      return { tool: "Edit", detail: path };
    case "read_file":
    case "read_many_files":
      return { tool: "Read", detail: firstString(path, args.paths as string) };
    case "glob":
      return { tool: "Glob", detail: firstString(args.pattern) };
    case "search_file_content":
    case "grep":
      return { tool: "Grep", detail: firstString(args.pattern) };
    case "google_web_search":
      return { tool: "WebSearch", detail: firstString(args.query) };
    case "web_fetch":
      return { tool: "WebFetch", detail: firstString(args.prompt, args.url) };
    default:
      return { tool: name, detail: firstString(path, args.command, args.query, args.id) };
  }
}

/** The text a `message` line contributes: the delta when streaming, else the
 *  whole content (#243 — a line carrying both is a delta line). */
export function messageText(obj: Record<string, unknown>): string | undefined {
  return firstString(obj.delta, obj.content);
}

export function mapGeminiLine(line: unknown): CodingEvent | null {
  const obj = asRecord(line);
  if (!obj) return null;

  switch (obj.type) {
    case "init": {
      const sessionId = firstString(obj.session_id, obj.sessionId);
      if (!sessionId) return null;
      return {
        kind: "agent-init",
        sessionId,
        ...(typeof obj.model === "string" ? { model: obj.model } : {}),
      };
    }
    case "message": {
      if (obj.role !== "assistant") return null;
      const text = messageText(obj);
      return text && text.trim() ? { kind: "text", text } : null;
    }
    case "tool_use": {
      const name = firstString(obj.tool_name, obj.name);
      if (!name) return null;
      const args = asRecord(obj.parameters) ?? asRecord(obj.args) ?? {};
      const { tool, detail } = normalizeTool(name, args);
      return toolUse(tool, detail, args);
    }
    case "error": {
      if (obj.severity !== undefined && obj.severity !== "error") return null;
      const message = firstString(obj.message, asRecord(obj.error)?.message);
      return { kind: "error", message: message ?? "gemini reported an error" };
    }
    default:
      return null;
  }
}

/** Fields a `result` line overrides on the synthesized outcome (#243). It carries
 *  no text of its own, so the summary always comes from the last agent message. */
interface ResultOverrides {
  ok?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

/** What a finished gemini run distilled to. Gemini does emit a terminal `result`
 *  line, but a crashed process may not — the outcome is synthesized from the
 *  stream either way and the result line only overrides it. */
export interface GeminiRunOutcome {
  event: Extract<CodingEvent, { kind: "result" }>;
  /** Full untruncated final agent message (the result event's summary is capped). */
  resultText?: string;
  /** The session id a later `gemini --resume` needs — pre-minted, or the id the
   *  init event reported. */
  sessionId?: string;
  /** Set when the run aborted or the CLI reported an error. */
  failure?: string;
}

export interface GeminiRunAccumulator extends NdjsonFeeder {
  finish: () => GeminiRunOutcome;
}

function readStats(source: Record<string, unknown> | undefined):
  | { inputTokens: number; outputTokens: number }
  | undefined {
  const stats = asRecord(source?.stats) ?? source;
  if (!stats) return undefined;
  const input = [stats.input_tokens, stats.inputTokens, stats.prompt_tokens].find(
    (v) => typeof v === "number",
  );
  const output = [stats.output_tokens, stats.outputTokens, stats.completion_tokens].find(
    (v) => typeof v === "number",
  );
  return typeof input === "number" && typeof output === "number"
    ? { inputTokens: input, outputTokens: output }
    : undefined;
}

/**
 * Feeds the gemini stream-json output: forwards mapped events and accumulates the
 * run state (session id, last agent message, token usage, failure) the terminal
 * result event is built from. Assistant text arrives as deltas, so it is buffered
 * and flushed as one `text` event when any other line arrives (or at finish) —
 * a per-delta event would flood the console with fragments. No turn events exist
 * in this stream, so the result event carries no turn count (#243 D7).
 */
export function createGeminiRunAccumulator(
  onEvent: (event: CodingEvent) => void,
  premintedSessionId?: string,
): GeminiRunAccumulator {
  let sessionId = premintedSessionId;
  let lastAgentMessage: string | undefined;
  let failure: string | undefined;
  let sawUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let pendingText = "";
  let overrides: ResultOverrides = {};

  const flushText = () => {
    if (!pendingText.trim()) {
      pendingText = "";
      return;
    }
    lastAgentMessage = pendingText;
    onEvent({ kind: "text", text: pendingText });
    pendingText = "";
  };

  const feeder = createNdjsonFeeder((line) => {
    if (line.type === "message") {
      if (line.role !== "assistant") return;
      pendingText += messageText(line) ?? "";
      return;
    }

    flushText();

    if (line.type === "result") {
      const usage = readStats(line);
      if (usage) {
        sawUsage = true;
        inputTokens = usage.inputTokens;
        outputTokens = usage.outputTokens;
      }
      const error = firstString(
        typeof line.error === "string" ? line.error : undefined,
        asRecord(line.error)?.message,
      );
      overrides = {
        ...(typeof line.status === "string" ? { ok: line.status === "success" } : {}),
        ...(usage ? { usage } : {}),
      };
      if (error) failure = error;
      else if (typeof line.status === "string" && line.status !== "success" && !failure) {
        failure = `gemini run ended with status ${line.status}`;
      }
      return;
    }

    // tool_result is dropped for console parity with the claude stream: a failed
    // tool is the agent's problem to recover from, never the run's outcome.
    if (line.type === "tool_result") return;

    const event = mapGeminiLine(line);
    if (!event) return;
    if (event.kind === "agent-init") sessionId = event.sessionId;
    if (event.kind === "error") failure = event.message;
    onEvent(event);
  });

  return {
    feed: feeder.feed,
    flush() {
      feeder.flush();
      flushText();
    },
    finish() {
      flushText();
      const summary = lastAgentMessage ?? failure;
      const usage = overrides.usage ?? (sawUsage ? { inputTokens, outputTokens } : undefined);
      return {
        event: {
          kind: "result",
          ok: (overrides.ok ?? true) && failure === undefined,
          ...(summary ? { summary: summary.slice(0, SUMMARY_MAX) } : {}),
          ...(usage ? { usage } : {}),
        },
        ...(lastAgentMessage !== undefined ? { resultText: lastAgentMessage } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(failure !== undefined ? { failure } : {}),
      };
    },
  };
}
