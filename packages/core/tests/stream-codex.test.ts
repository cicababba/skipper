import { describe, it, expect } from "vitest";
import type { CodingEvent } from "@skipper/shared";
import { createCodexStreamParser, mapCodexLine } from "../src/llm/stream-codex";

/** Captured verbatim from codex 0.144.4 (`exec --json`). */
const HAPPY = [
  `{"type":"thread.started","thread_id":"019f6680-00d1-7903-8d8c-45455f3264cf"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll inspect the TypeScript files."}}`,
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/zsh -lc \\"rg --files\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/zsh -lc \\"rg --files\\"","aggregated_output":"code.ts\\n","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"- \`code.ts\` — exports \`answer\`, value \`42\`."}}`,
  `{"type":"turn.completed","usage":{"input_tokens":35102,"cached_input_tokens":32000,"output_tokens":178,"reasoning_output_tokens":13}}`,
].join("\n");

function collect(chunk: string): CodingEvent[] {
  const events: CodingEvent[] = [];
  const parser = createCodexStreamParser((e) => events.push(e));
  parser.feed(chunk);
  parser.flush();
  return events;
}

describe("codex stream mapping", () => {
  it("maps a full happy-path run", () => {
    const events = collect(HAPPY);
    expect(events.map((e) => e.kind)).toEqual([
      "agent-init",
      "text",
      "tool-use",
      "text",
      "result",
    ]);
    expect(events[0]).toMatchObject({ sessionId: "019f6680-00d1-7903-8d8c-45455f3264cf" });
    expect(events[2]).toMatchObject({ kind: "tool-use", tool: "Bash" });
  });

  it("emits one tool-use per command, not one per item lifecycle event", () => {
    // command_execution fires on BOTH item.started and item.completed.
    const toolUses = collect(HAPPY).filter((e) => e.kind === "tool-use");
    expect(toolUses).toHaveLength(1);
  });

  it("takes the summary from the last agent_message, since turn.completed has no text", () => {
    const result = collect(HAPPY).find((e) => e.kind === "result");
    expect(result).toMatchObject({
      ok: true,
      summary: "- `code.ts` — exports `answer`, value `42`.",
      usage: { inputTokens: 35102, outputTokens: 178 },
    });
  });

  it("drops transient retry noise and surfaces only the terminal failure", () => {
    // One auth failure emits a dozen of these before turn.failed.
    const stream = [
      `{"type":"thread.started","thread_id":"t1"}`,
      `{"type":"error","message":"Reconnecting... 1/5 (401 Unauthorized)"}`,
      `{"type":"error","message":"Reconnecting... 2/5 (401 Unauthorized)"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back to HTTPS"}}`,
      `{"type":"error","message":"unexpected status 401 Unauthorized"}`,
      `{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}`,
    ].join("\n");
    const events = collect(stream);
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "unexpected status 401 Unauthorized" });
    expect(events.find((e) => e.kind === "result")).toMatchObject({ ok: false });
  });

  it("maps file_change, carrying the extra paths in the detail", () => {
    const single = collect(
      `{"type":"item.started","item":{"id":"i","type":"file_change","changes":[{"path":"/w/hello.ts","kind":"add"}],"status":"in_progress"}}`,
    );
    expect(single[0]).toMatchObject({ kind: "tool-use", tool: "Edit", detail: "/w/hello.ts" });

    const multi = collect(
      `{"type":"item.started","item":{"id":"i","type":"file_change","changes":[{"path":"/w/a.ts","kind":"add"},{"path":"/w/b.ts","kind":"update"}],"status":"in_progress"}}`,
    );
    expect(multi[0]).toMatchObject({ detail: "/w/a.ts (+1 more)" });
  });

  it("degrades to fewer events rather than crashing on drift", () => {
    expect(mapCodexLine({ type: "some.future.event", payload: 1 })).toEqual([]);
    expect(mapCodexLine({ type: "item.started", item: { type: "brand_new" } })).toEqual([]);
    expect(mapCodexLine(null)).toEqual([]);
    expect(mapCodexLine("nonsense")).toEqual([]);
    expect(collect(`not json\n{"type":"thread.started","thread_id":"t"}`)).toHaveLength(1);
  });

  it("buffers lines split across chunks", () => {
    const events: CodingEvent[] = [];
    const parser = createCodexStreamParser((e) => events.push(e));
    parser.feed(`{"type":"thread.st`);
    parser.feed(`arted","thread_id":"t9"}\n`);
    parser.flush();
    expect(events[0]).toMatchObject({ kind: "agent-init", sessionId: "t9" });
  });
});
