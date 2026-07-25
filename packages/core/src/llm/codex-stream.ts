import type { CodingEvent } from "@skipper/shared";
import { createNdjsonFeeder, type NdjsonFeeder } from "./stream";

const SUMMARY_MAX = 2000;
const DETAIL_MAX = 120;
const INPUT_MAX = 2000;

// The codex CLI's `--json` event stream (#239). Shapes captured from a live run:
//   {"type":"thread.started","thread_id":"019f…"}
//   {"type":"turn.started"}
//   {"type":"item.started"|"item.completed","item":{"id":"item_0","type":"…",…}}
//   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
// Tolerant like mapStreamLine: unknown types and malformed lines map to null.

function capInput(payload: Record<string, unknown>): string | undefined {
  if (Object.keys(payload).length === 0) return undefined;
  try {
    return JSON.stringify(payload, null, 2).slice(0, INPUT_MAX);
  } catch {
    return undefined;
  }
}

function toolUse(
  tool: string,
  detail: unknown,
  payload: Record<string, unknown>,
): CodingEvent {
  const full = capInput(payload);
  return {
    kind: "tool-use",
    tool,
    ...(typeof detail === "string" && detail ? { detail: detail.slice(0, DETAIL_MAX) } : {}),
    ...(full ? { input: full } : {}),
  };
}

/** One `item.started` / `item.completed` line → the event its item type maps to. */
function mapItem(item: Record<string, unknown>, completed: boolean): CodingEvent | null {
  switch (item.type) {
    // Codex streams the message text only on completion; the started line carries none.
    case "agent_message":
      return completed && typeof item.text === "string" && item.text.trim()
        ? { kind: "text", text: item.text }
        : null;
    // Emitted on start so the console shows the command while it runs.
    case "command_execution":
      return completed || typeof item.command !== "string"
        ? null
        : toolUse("Bash", item.command, { command: item.command });
    // Codex reports writes post-hoc, so only the completed line carries changes.
    case "file_change": {
      if (!completed || !Array.isArray(item.changes) || item.changes.length === 0) return null;
      const first = item.changes[0] as Record<string, unknown> | undefined;
      return toolUse("Edit", first?.path, { changes: item.changes });
    }
    case "mcp_tool_call": {
      if (completed || typeof item.server !== "string" || typeof item.tool !== "string") return null;
      const args = (item.arguments ?? {}) as Record<string, unknown>;
      // query/id carry the skipper-memory payloads — the get_memory id is the
      // ground truth for the "memories used" card (#46).
      const detail = [args.query, args.id].find((v) => typeof v === "string" && v);
      return toolUse(`mcp__${item.server}__${item.tool}`, detail, args);
    }
    case "web_search":
      return typeof item.query === "string"
        ? toolUse("WebSearch", item.query, { query: item.query })
        : null;
    // reasoning / plan_update and anything newer: dropped, for console parity
    // with the claude stream.
    default:
      return null;
  }
}

export function mapCodexLine(line: unknown): CodingEvent | null {
  if (typeof line !== "object" || line === null) return null;
  const obj = line as Record<string, unknown>;

  if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
    return { kind: "agent-init", sessionId: obj.thread_id };
  }

  if (obj.type === "item.started" || obj.type === "item.completed") {
    const item = obj.item;
    if (typeof item !== "object" || item === null) return null;
    return mapItem(item as Record<string, unknown>, obj.type === "item.completed");
  }

  if (obj.type === "error" && typeof obj.message === "string") {
    return { kind: "error", message: obj.message };
  }

  return null;
}

/** What a finished codex run distilled to — codex emits no terminal result line,
 *  so the result event is synthesized from the accumulated stream. */
export interface CodexRunOutcome {
  event: Extract<CodingEvent, { kind: "result" }>;
  /** Full untruncated final agent message (the result event's summary is capped). */
  resultText?: string;
  /** thread_id from thread.started — the id a later `codex exec resume` needs. */
  sessionId?: string;
  /** Set when a turn failed or the CLI reported an error. */
  failure?: string;
}

export interface CodexRunAccumulator extends NdjsonFeeder {
  finish: () => CodexRunOutcome;
}

/**
 * Feeds the codex `--json` stream: forwards mapped events and accumulates the
 * run state (thread id, last agent message, turn count, token usage, failure)
 * that the synthesized result event is built from.
 */
export function createCodexRunAccumulator(
  onEvent: (event: CodingEvent) => void,
): CodexRunAccumulator {
  let sessionId: string | undefined;
  let lastAgentMessage: string | undefined;
  let failure: string | undefined;
  let turns = 0;
  let sawUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;

  const feeder = createNdjsonFeeder((line) => {
    if (line.type === "turn.completed") {
      turns++;
      const usage = line.usage as Record<string, unknown> | undefined;
      if (typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number") {
        sawUsage = true;
        inputTokens += usage.input_tokens;
        outputTokens += usage.output_tokens;
      }
      return;
    }
    if (line.type === "turn.failed") {
      const error = line.error as Record<string, unknown> | undefined;
      failure =
        typeof error?.message === "string" ? error.message : "codex turn failed";
      return;
    }
    const event = mapCodexLine(line);
    if (!event) return;
    if (event.kind === "agent-init") sessionId = event.sessionId;
    if (event.kind === "text") lastAgentMessage = event.text;
    if (event.kind === "error") failure = event.message;
    onEvent(event);
  });

  return {
    feed: feeder.feed,
    flush: feeder.flush,
    finish() {
      const summary = lastAgentMessage ?? failure;
      return {
        event: {
          kind: "result",
          ok: failure === undefined,
          ...(summary ? { summary: summary.slice(0, SUMMARY_MAX) } : {}),
          turns,
          ...(sawUsage ? { usage: { inputTokens, outputTokens } } : {}),
        },
        ...(lastAgentMessage !== undefined ? { resultText: lastAgentMessage } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(failure !== undefined ? { failure } : {}),
      };
    },
  };
}
