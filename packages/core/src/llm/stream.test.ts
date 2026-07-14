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
    expect(event).toEqual({
      kind: "tool-use",
      tool: "mcp__skipper-memory__search_memory",
      detail: "oauth refresh race",
    });
  });

  it("carries the get_memory id as detail", () => {
    const [event] = eventsFor(
      toolUse("mcp__skipper-memory__get_memory", { id: "github:1234567890" }),
    );
    expect(event).toEqual({
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
