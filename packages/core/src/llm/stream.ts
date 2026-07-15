import type { CodingEvent } from "@skipper/shared";
import { createNdjsonBuffer } from "./ndjson";

const SUMMARY_MAX = 2000;
const DETAIL_MAX = 120;

// Tolerant by design: unknown types and malformed lines map to null so CLI
// schema drift degrades to fewer events, never a crash.
export function mapStreamLine(line: unknown): CodingEvent | null {
  if (typeof line !== "object" || line === null) return null;
  const obj = line as Record<string, unknown>;

  if (obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    return {
      kind: "agent-init",
      sessionId: obj.session_id,
      ...(typeof obj.model === "string" ? { model: obj.model } : {}),
      ...(Array.isArray(obj.tools) ? { tools: obj.tools.filter((t) => typeof t === "string") } : {}),
    };
  }

  if (obj.type === "result") {
    const usage = obj.usage as Record<string, unknown> | undefined;
    return {
      kind: "result",
      ok: !obj.is_error && obj.subtype === "success",
      ...(typeof obj.result === "string" ? { summary: obj.result.slice(0, SUMMARY_MAX) } : {}),
      ...(typeof obj.num_turns === "number" ? { turns: obj.num_turns } : {}),
      ...(typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number"
        ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
        : {}),
    };
  }

  return null;
}

/** An "assistant" line can carry several content blocks — map each to an event. */
function mapAssistantLine(line: Record<string, unknown>): CodingEvent[] {
  const message = line.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const events: CodingEvent[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      events.push({ kind: "text", text: b.text });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      const input = (b.input ?? {}) as Record<string, unknown>;
      // query/id carry the skipper-memory tool payloads (search_memory/get_memory);
      // the get_memory id is the ground truth for the "memories used" card (#46).
      const detail = [
        input.file_path,
        input.command,
        input.pattern,
        input.query,
        input.id,
      ].find((v) => typeof v === "string" && v) as string | undefined;
      events.push({
        kind: "tool-use",
        tool: b.name,
        ...(detail ? { detail: detail.slice(0, DETAIL_MAX) } : {}),
      });
    }
  }
  return events;
}

export interface StreamJsonParser {
  feed: (chunk: string) => void;
  flush: () => void;
}

/**
 * Stateful NDJSON feeder: buffers partial lines across chunks. `onLine` sees
 * every parsed line raw — mapped events truncate (e.g. result summary), so
 * callers that need the full result text must take it from here.
 */
export function createStreamJsonParser(
  onEvent: (event: CodingEvent) => void,
  onLine?: (line: Record<string, unknown>) => void,
): StreamJsonParser {
  return createNdjsonBuffer((obj) => {
    onLine?.(obj);
    if (obj.type === "assistant") {
      for (const event of mapAssistantLine(obj)) onEvent(event);
      return;
    }
    const event = mapStreamLine(obj);
    if (event) onEvent(event);
  });
}
