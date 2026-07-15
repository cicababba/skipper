import type { CodingEvent } from "@skipper/shared";
import { createNdjsonBuffer } from "./ndjson";
import type { StreamJsonParser } from "./stream";

const SUMMARY_MAX = 2000;
const DETAIL_MAX = 120;

/**
 * Maps a codex `exec --json` ThreadEvent onto our provider-neutral CodingEvent.
 *
 * Tolerant by design, like stream.ts: unknown shapes map to nothing so CLI
 * schema drift degrades to fewer events, never a crash. Codex ships roughly a
 * release every other day with no breaking-change log, so this matters more
 * here than on the claude path.
 *
 * Returns an array because one line can fan out (turn.failed is both an error
 * to show and a terminal result to settle on).
 */
export function mapCodexLine(line: unknown): CodingEvent[] {
  if (typeof line !== "object" || line === null) return [];
  const obj = line as Record<string, unknown>;

  if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
    return [{ kind: "agent-init", sessionId: obj.thread_id }];
  }

  if (obj.type === "turn.completed") {
    // Carries usage only — no result text, unlike claude's result line. The
    // summary is grafted on by the parser from the last agent_message.
    const usage = obj.usage as Record<string, unknown> | undefined;
    return [
      {
        kind: "result",
        ok: true,
        ...(typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number"
          ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
          : {}),
      },
    ];
  }

  if (obj.type === "turn.failed") {
    const error = obj.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === "string" ? error.message : "codex run failed";
    return [
      { kind: "error", message },
      { kind: "result", ok: false, summary: message.slice(0, SUMMARY_MAX) },
    ];
  }

  if (obj.type === "item.started" || obj.type === "item.completed") {
    return mapItem(obj.type, obj.item);
  }

  // Bare {"type":"error"} lines are transient retry noise: one auth failure
  // emits a dozen ("Reconnecting... 2/5", then the same again after the
  // WebSocket→HTTPS fallback). Only turn.failed is terminal, so these are
  // dropped rather than shown as a dozen separate failures.
  return [];
}

function mapItem(outer: string, item: unknown): CodingEvent[] {
  if (typeof item !== "object" || item === null) return [];
  const it = item as Record<string, unknown>;

  // agent_message has no in-progress form — it only lands on item.completed.
  if (it.type === "agent_message") {
    if (outer !== "item.completed") return [];
    return typeof it.text === "string" && it.text.trim() ? [{ kind: "text", text: it.text }] : [];
  }

  // Everything below fires on BOTH item.started and item.completed. Map only
  // the start, or every tool-use renders twice.
  if (outer !== "item.started") return [];

  if (it.type === "command_execution") {
    const detail = typeof it.command === "string" ? it.command : undefined;
    return [
      { kind: "tool-use", tool: "Bash", ...(detail ? { detail: detail.slice(0, DETAIL_MAX) } : {}) },
    ];
  }

  if (it.type === "file_change") {
    // `changes` is an array — one item can touch several paths.
    const changes = Array.isArray(it.changes) ? it.changes : [];
    const first = changes.find((c) => typeof c === "object" && c !== null) as
      | Record<string, unknown>
      | undefined;
    const path = typeof first?.path === "string" ? first.path : undefined;
    const detail =
      path && changes.length > 1 ? `${path} (+${changes.length - 1} more)` : path;
    return [
      { kind: "tool-use", tool: "Edit", ...(detail ? { detail: detail.slice(0, DETAIL_MAX) } : {}) },
    ];
  }

  if (it.type === "mcp_tool_call") {
    const detail = [it.tool, it.server, it.name].find((v) => typeof v === "string" && v) as
      | string
      | undefined;
    return [
      { kind: "tool-use", tool: "mcp", ...(detail ? { detail: detail.slice(0, DETAIL_MAX) } : {}) },
    ];
  }

  return [];
}

/**
 * Stateful codex stream parser. `onLine` sees every raw line — callers needing
 * the untruncated final text take it from there (or from `-o`), since the
 * mapped result summary is capped.
 */
export function createCodexStreamParser(
  onEvent: (event: CodingEvent) => void,
  onLine?: (line: Record<string, unknown>) => void,
): StreamJsonParser {
  // turn.completed has no text of its own, so the run summary is the last
  // agent_message seen. Note codex emits several: a preamble ("I'll inspect
  // the files…") and the real answer — last one wins, never concatenated.
  let lastMessage = "";

  return createNdjsonBuffer((obj) => {
    onLine?.(obj);
    if (obj.type === "item.completed") {
      const item = obj.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        lastMessage = item.text;
      }
    }
    for (const event of mapCodexLine(obj)) {
      if (event.kind === "result" && event.summary === undefined && lastMessage) {
        onEvent({ ...event, summary: lastMessage.slice(0, SUMMARY_MAX) });
      } else {
        onEvent(event);
      }
    }
  });
}
