import { describe, expect, it } from "vitest";
import type { CodingEvent } from "@skipper/shared";
import { createStreamJsonParser } from "./stream";

/** Drive an assistant line through the parser and collect the emitted events. */
function eventsFor(line: Record<string, unknown>): CodingEvent[] {
  const events: CodingEvent[] = [];
  const parser = createStreamJsonParser((e) => events.push(e));
  parser.feed(JSON.stringify(line) + "\n");
  return events;
}

function toolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "tool_use", name, input }] } };
}

describe("mapAssistantLine memory tool payloads (#46)", () => {
  it("carries the search_memory query as detail", () => {
    const [event] = eventsFor(
      toolUse("mcp__skipper-memory__search_memory", { query: "oauth refresh race" }),
    );
    expect(event).toMatchObject({
      kind: "tool-use",
      tool: "mcp__skipper-memory__search_memory",
      detail: "oauth refresh race",
    });
  });

  it("carries the get_memory id as detail", () => {
    const [event] = eventsFor(
      toolUse("mcp__skipper-memory__get_memory", { id: "github:1234567890" }),
    );
    expect(event).toMatchObject({
      kind: "tool-use",
      tool: "mcp__skipper-memory__get_memory",
      detail: "github:1234567890",
    });
  });

  it("still prefers file_path/command/pattern for ordinary tools", () => {
    const [event] = eventsFor(toolUse("Read", { file_path: "/tmp/x.ts" }));
    expect(event).toMatchObject({ kind: "tool-use", tool: "Read", detail: "/tmp/x.ts" });
  });
});

describe("mapAssistantLine tool input expand view (#113)", () => {
  it("carries the full input as pretty-printed JSON", () => {
    const [event] = eventsFor(toolUse("Read", { file_path: "/tmp/x.ts" }));
    expect(event.kind).toBe("tool-use");
    if (event.kind !== "tool-use") throw new Error("expected tool-use");
    expect(event.input).toBe(JSON.stringify({ file_path: "/tmp/x.ts" }, null, 2));
  });

  it("caps the input at 2000 chars", () => {
    const [event] = eventsFor(toolUse("Write", { content: "x".repeat(5000) }));
    if (event.kind !== "tool-use") throw new Error("expected tool-use");
    expect(event.input?.length).toBe(2000);
  });

  it("omits input for an empty input object", () => {
    const [event] = eventsFor(toolUse("NoArgs", {}));
    if (event.kind !== "tool-use") throw new Error("expected tool-use");
    expect(event.input).toBeUndefined();
  });
});

/** Drive several raw lines through a single parser and collect the events. */
function eventsForLines(lines: Record<string, unknown>[]): CodingEvent[] {
  const events: CodingEvent[] = [];
  const parser = createStreamJsonParser((e) => events.push(e));
  for (const line of lines) parser.feed(JSON.stringify(line) + "\n");
  parser.flush();
  return events;
}

function textDelta(text: string): Record<string, unknown> {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

const blockStop = { type: "stream_event", event: { type: "content_block_stop" } };

describe("stream_event partial messages (#277)", () => {
  it("flushes coalesced deltas as one text-delta on content_block_stop", () => {
    const events = eventsForLines([textDelta("Hel"), textDelta("lo"), blockStop]);
    expect(events).toEqual([{ kind: "text-delta", text: "Hello" }]);
  });

  it("coalesces long deltas into bounded chunks", () => {
    const chunk = "x".repeat(50);
    const events = eventsForLines([
      textDelta(chunk),
      textDelta(chunk),
      textDelta(chunk),
      blockStop,
    ]);
    // The buffer flushes once it crosses the 64-char threshold, so 150 chars of
    // deltas coalesce into a bounded number of events (not one per delta), and
    // the concatenation reconstructs the full streamed text.
    expect(events.length).toBeGreaterThan(1);
    expect(events.length).toBeLessThan(3);
    expect(events.map((e) => (e.kind === "text-delta" ? e.text : "")).join("")).toBe(
      chunk.repeat(3),
    );
  });

  it("suppresses the block text once deltas streamed but keeps tool_use", () => {
    const assistant = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", name: "Read", input: { file_path: "/tmp/x.ts" } },
        ],
      },
    };
    const events = eventsForLines([textDelta("Hello"), blockStop, assistant]);
    expect(events).toEqual([
      { kind: "text-delta", text: "Hello" },
      {
        kind: "tool-use",
        tool: "Read",
        detail: "/tmp/x.ts",
        input: JSON.stringify({ file_path: "/tmp/x.ts" }, null, 2),
      },
    ]);
  });

  it("keeps the block text when no deltas streamed", () => {
    const events = eventsForLines([
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
    ]);
    expect(events).toEqual([{ kind: "text", text: "Hello" }]);
  });

  it("maps a stream_event with no partials to nothing", () => {
    const events = eventsForLines([{ type: "stream_event", event: { type: "message_start" } }]);
    expect(events).toEqual([]);
  });
});
