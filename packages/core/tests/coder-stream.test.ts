import { describe, it, expect } from "vitest";
import type { CodingEvent } from "@nestbrain/shared";
import { mapStreamLine, createStreamJsonParser } from "../src/coder";

const initLine = {
  type: "system",
  subtype: "init",
  session_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  model: "claude-opus-4",
  tools: ["Read", "Edit", "Bash"],
};

const resultLine = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Implemented the feature.",
  num_turns: 12,
  usage: { input_tokens: 100, output_tokens: 200 },
};

describe("mapStreamLine", () => {
  it("maps system/init to agent-init", () => {
    expect(mapStreamLine(initLine)).toEqual({
      kind: "agent-init",
      sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      model: "claude-opus-4",
      tools: ["Read", "Edit", "Bash"],
    });
  });

  it("maps a successful result", () => {
    expect(mapStreamLine(resultLine)).toEqual({
      kind: "result",
      ok: true,
      summary: "Implemented the feature.",
      turns: 12,
      usage: { inputTokens: 100, outputTokens: 200 },
    });
  });

  it("maps an error result to ok=false", () => {
    const event = mapStreamLine({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "hit the turn limit",
    });
    expect(event).toMatchObject({ kind: "result", ok: false });
  });

  it("truncates a long result summary", () => {
    const event = mapStreamLine({ ...resultLine, result: "x".repeat(5000) }) as Extract<
      CodingEvent,
      { kind: "result" }
    >;
    expect(event.summary).toHaveLength(2000);
  });

  it("ignores unknown line types", () => {
    expect(mapStreamLine({ type: "rate_limit_event" })).toBeNull();
    expect(mapStreamLine({ type: "user", message: {} })).toBeNull();
    expect(mapStreamLine("garbage")).toBeNull();
    expect(mapStreamLine(null)).toBeNull();
  });
});

describe("createStreamJsonParser", () => {
  function collect(): { events: CodingEvent[]; parser: ReturnType<typeof createStreamJsonParser> } {
    const events: CodingEvent[] = [];
    const parser = createStreamJsonParser((e) => events.push(e));
    return { events, parser };
  }

  it("parses multiple lines in one chunk", () => {
    const { events, parser } = collect();
    parser.feed(`${JSON.stringify(initLine)}\n${JSON.stringify(resultLine)}\n`);
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "result"]);
  });

  it("buffers a line split across chunks", () => {
    const { events, parser } = collect();
    const line = JSON.stringify(initLine);
    parser.feed(line.slice(0, 20));
    expect(events).toHaveLength(0);
    parser.feed(`${line.slice(20)}\n`);
    expect(events.map((e) => e.kind)).toEqual(["agent-init"]);
  });

  it("flush emits a trailing line without newline", () => {
    const { events, parser } = collect();
    parser.feed(JSON.stringify(resultLine));
    expect(events).toHaveLength(0);
    parser.flush();
    expect(events.map((e) => e.kind)).toEqual(["result"]);
  });

  it("emits per-block events for assistant lines", () => {
    const { events, parser } = collect();
    const assistant = {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Editing the file now." },
          { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
          { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
        ],
      },
    };
    parser.feed(`${JSON.stringify(assistant)}\n`);
    expect(events).toEqual([
      { kind: "text", text: "Editing the file now." },
      { kind: "tool-use", tool: "Edit", detail: "src/a.ts" },
      { kind: "tool-use", tool: "Bash", detail: "pnpm test" },
    ]);
  });

  it("silently drops garbage and unknown lines", () => {
    const { events, parser } = collect();
    parser.feed(`not json at all\n{"type":"rate_limit_event"}\n\n${JSON.stringify(initLine)}\n`);
    expect(events.map((e) => e.kind)).toEqual(["agent-init"]);
  });

  it("onLine sees every parsed line raw, including the untruncated result", () => {
    const events: CodingEvent[] = [];
    const lines: Record<string, unknown>[] = [];
    const parser = createStreamJsonParser(
      (e) => events.push(e),
      (l) => lines.push(l),
    );
    const longResult = "y".repeat(5000);
    parser.feed(
      `${JSON.stringify(initLine)}\n{"type":"rate_limit_event"}\n${JSON.stringify({
        ...resultLine,
        result: longResult,
      })}\n`,
    );
    expect(lines.map((l) => l.type)).toEqual(["system", "rate_limit_event", "result"]);
    expect(lines[2].result).toBe(longResult);
    const result = events.find((e) => e.kind === "result") as Extract<
      CodingEvent,
      { kind: "result" }
    >;
    expect(result.summary).toHaveLength(2000);
  });
});
