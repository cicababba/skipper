import type { CodingEvent } from "@skipper/shared";

const SUMMARY_MAX = 2000;
const DETAIL_MAX = 120;
const INPUT_MAX = 2000;
// Coalesce partial-message text deltas until this many chars accumulate, then
// flush one `text-delta` event (#277). Bounds envelope count so a long streamed
// reply cannot fill the desktop replay buffer (EVENT_BUFFER_MAX = 500) and evict
// the turn opener; small enough that the draft bubble still grows smoothly.
const DELTA_FLUSH_CHARS = 64;

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
      let full: string | undefined;
      if (Object.keys(input).length > 0) {
        try {
          full = JSON.stringify(input, null, 2).slice(0, INPUT_MAX);
        } catch {
          full = undefined;
        }
      }
      events.push({
        kind: "tool-use",
        tool: b.name,
        ...(detail ? { detail: detail.slice(0, DETAIL_MAX) } : {}),
        ...(full ? { input: full } : {}),
      });
    }
  }
  return events;
}

export interface NdjsonFeeder {
  feed: (chunk: string) => void;
  flush: () => void;
}

export interface StreamJsonParser {
  feed: (chunk: string) => void;
  flush: () => void;
}

/**
 * Stateful NDJSON feeder: buffers partial lines across chunks and hands each
 * decoded line to `onLine`. Blank lines, unparseable lines and non-object JSON
 * are dropped — CLI schema drift degrades to fewer lines, never a crash. Shared
 * by the claude stream parser and the codex accumulator (#239).
 */
export function createNdjsonFeeder(onLine: (line: Record<string, unknown>) => void): NdjsonFeeder {
  let buffer = "";

  const emitLine = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    onLine(parsed as Record<string, unknown>);
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        emitLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush() {
      emitLine(buffer);
      buffer = "";
    },
  };
}

/**
 * The claude CLI's stream-json reader. `onLine` sees every parsed line raw —
 * mapped events truncate (e.g. result summary), so callers that need the full
 * result text must take it from here.
 */
export function createStreamJsonParser(
  onEvent: (event: CodingEvent) => void,
  onLine?: (line: Record<string, unknown>) => void,
): StreamJsonParser {
  let deltaBuffer = "";
  // True once the current message streamed text deltas — suppress the redundant
  // block-level `text` on the next assistant line so it is not shown twice.
  let streamedText = false;

  const flushDelta = () => {
    if (!deltaBuffer) return;
    onEvent({ kind: "text-delta", text: deltaBuffer });
    deltaBuffer = "";
  };

  return createNdjsonFeeder((line) => {
    onLine?.(line);

    // With --include-partial-messages the CLI interleaves Anthropic SSE deltas
    // as `stream_event` lines (#277); coalesce their text_delta chunks.
    if (line.type === "stream_event") {
      const event = line.event as Record<string, unknown> | undefined;
      if (typeof event !== "object" || event === null) return;
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          deltaBuffer += delta.text;
          streamedText = true;
          if (deltaBuffer.length >= DELTA_FLUSH_CHARS) flushDelta();
        }
        return;
      }
      if (event.type === "content_block_stop" || event.type === "message_stop") {
        flushDelta();
      }
      return;
    }

    if (line.type === "assistant") {
      const wasStreamed = streamedText;
      // A new assistant message closes the delta stream and resets suppression.
      flushDelta();
      streamedText = false;
      for (const event of mapAssistantLine(line)) {
        // The reply text already streamed as deltas — drop the duplicate block.
        if (wasStreamed && event.kind === "text") continue;
        onEvent(event);
      }
      return;
    }

    const event = mapStreamLine(line);
    if (event) onEvent(event);
  });
}
