import { describe, it, expect } from "vitest";
import type { CodingEvent } from "@skipper/shared";
import { mapCodexLine, createCodexRunAccumulator } from "../src/llm/codex-stream";

// Fixtures captured from a real `codex exec --json` run (codex-cli 0.144.4).
const THREAD_ID = "019f99b6-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const threadStarted = { type: "thread.started", thread_id: THREAD_ID };
const turnStarted = { type: "turn.started" };
const agentMessage = {
  type: "item.completed",
  item: { id: "item_0", type: "agent_message", text: "Listed the repo root." },
};
const commandStarted = {
  type: "item.started",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "/usr/bin/zsh -lc ls",
    aggregated_output: "",
    exit_code: null,
    status: "in_progress",
  },
};
const commandCompleted = {
  type: "item.completed",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "/usr/bin/zsh -lc ls",
    aggregated_output: "src\npackage.json\n",
    exit_code: 0,
    status: "completed",
  },
};
const turnCompleted = {
  type: "turn.completed",
  usage: {
    input_tokens: 25237,
    cached_input_tokens: 12032,
    output_tokens: 112,
    reasoning_output_tokens: 0,
  },
};

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

describe("mapCodexLine", () => {
  it("maps thread.started to agent-init carrying the minted thread id", () => {
    expect(mapCodexLine(threadStarted)).toEqual({ kind: "agent-init", sessionId: THREAD_ID });
  });

  it("maps a completed agent_message to an untruncated text event", () => {
    expect(mapCodexLine(agentMessage)).toEqual({ kind: "text", text: "Listed the repo root." });
  });

  it("drops an agent_message on item.started (the text only lands on completion)", () => {
    expect(mapCodexLine({ type: "item.started", item: { type: "agent_message" } })).toBeNull();
  });

  it("drops a whitespace-only agent_message", () => {
    expect(
      mapCodexLine({ type: "item.completed", item: { type: "agent_message", text: "   " } }),
    ).toBeNull();
  });

  it("maps a started command_execution to a Bash tool-use with the command", () => {
    expect(mapCodexLine(commandStarted)).toEqual({
      kind: "tool-use",
      tool: "Bash",
      detail: "/usr/bin/zsh -lc ls",
      input: JSON.stringify({ command: "/usr/bin/zsh -lc ls" }, null, 2),
    });
  });

  it("drops the completed command_execution so a command logs once", () => {
    expect(mapCodexLine(commandCompleted)).toBeNull();
  });

  it("maps a completed file_change to an Edit tool-use detailed with the first path", () => {
    const changes = [
      { path: "src/a.ts", kind: "modify" },
      { path: "src/b.ts", kind: "add" },
    ];
    expect(mapCodexLine({ type: "item.completed", item: { type: "file_change", changes } })).toEqual(
      {
        kind: "tool-use",
        tool: "Edit",
        detail: "src/a.ts",
        input: JSON.stringify({ changes }, null, 2),
      },
    );
  });

  it("drops a file_change with no changes, and one on item.started", () => {
    expect(
      mapCodexLine({ type: "item.completed", item: { type: "file_change", changes: [] } }),
    ).toBeNull();
    expect(
      mapCodexLine({
        type: "item.started",
        item: { type: "file_change", changes: [{ path: "src/a.ts" }] },
      }),
    ).toBeNull();
  });

  it("maps a started mcp_tool_call to the mcp__server__tool name (#46 memory card)", () => {
    expect(
      mapCodexLine({
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          server: "skipper-memory",
          tool: "get_memory",
          arguments: { id: "sol-42" },
        },
      }),
    ).toEqual({
      kind: "tool-use",
      tool: "mcp__skipper-memory__get_memory",
      detail: "sol-42",
      input: JSON.stringify({ id: "sol-42" }, null, 2),
    });
  });

  it("prefers the query argument over id for the mcp detail", () => {
    const event = mapCodexLine({
      type: "item.started",
      item: {
        type: "mcp_tool_call",
        server: "skipper-memory",
        tool: "search_memory",
        arguments: { query: "flaky worktree lock", id: "ignored" },
      },
    });
    expect(event).toMatchObject({ tool: "mcp__skipper-memory__search_memory", detail: "flaky worktree lock" });
  });

  // Pinning current behavior: the mapper accepts web_search on either item line,
  // so a codex that emits both start and completion logs the search twice.
  it("maps web_search on both item.started and item.completed", () => {
    const item = { type: "web_search", query: "electron pty windows" };
    const expected = {
      kind: "tool-use",
      tool: "WebSearch",
      detail: "electron pty windows",
      input: JSON.stringify({ query: "electron pty windows" }, null, 2),
    };
    expect(mapCodexLine({ type: "item.started", item })).toEqual(expected);
    expect(mapCodexLine({ type: "item.completed", item })).toEqual(expected);
  });

  it("maps a top-level error line to an error event", () => {
    expect(mapCodexLine({ type: "error", message: "stream broke" })).toEqual({
      kind: "error",
      message: "stream broke",
    });
  });

  it("drops reasoning, plan_update, turn lines and unknown item types", () => {
    expect(mapCodexLine({ type: "item.completed", item: { type: "reasoning", text: "hmm" } })).toBeNull();
    expect(mapCodexLine({ type: "item.completed", item: { type: "plan_update", plan: [] } })).toBeNull();
    expect(mapCodexLine({ type: "item.completed", item: { type: "future_thing" } })).toBeNull();
    expect(mapCodexLine(turnStarted)).toBeNull();
    expect(mapCodexLine(turnCompleted)).toBeNull();
  });

  it("never crashes on malformed input", () => {
    expect(mapCodexLine(null)).toBeNull();
    expect(mapCodexLine("not an object")).toBeNull();
    expect(mapCodexLine(42)).toBeNull();
    expect(mapCodexLine({})).toBeNull();
    expect(mapCodexLine({ type: "thread.started" })).toBeNull();
    expect(mapCodexLine({ type: "item.started" })).toBeNull();
    expect(mapCodexLine({ type: "item.started", item: null })).toBeNull();
    expect(mapCodexLine({ type: "error" })).toBeNull();
  });

  it("caps the tool detail at 120 chars and the input payload at 2000", () => {
    const command = "x".repeat(5000);
    const event = mapCodexLine({
      type: "item.started",
      item: { type: "command_execution", command },
    }) as Extract<CodingEvent, { kind: "tool-use" }>;
    expect(event.detail!.length).toBe(120);
    expect(event.input!.length).toBe(2000);
  });
});

describe("createCodexRunAccumulator", () => {
  function feedAll(lines: unknown[]): { events: CodingEvent[]; acc: ReturnType<typeof createCodexRunAccumulator> } {
    const events: CodingEvent[] = [];
    const acc = createCodexRunAccumulator((e) => events.push(e));
    for (const l of lines) acc.feed(line(l));
    acc.flush();
    return { events, acc };
  }

  it("forwards mapped events and synthesizes an ok result with turns and usage", () => {
    const { events, acc } = feedAll([
      threadStarted,
      turnStarted,
      commandStarted,
      agentMessage,
      turnCompleted,
    ]);
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "tool-use", "text"]);
    const outcome = acc.finish();
    expect(outcome.sessionId).toBe(THREAD_ID);
    expect(outcome.resultText).toBe("Listed the repo root.");
    expect(outcome.failure).toBeUndefined();
    expect(outcome.event).toEqual({
      kind: "result",
      ok: true,
      summary: "Listed the repo root.",
      turns: 1,
      usage: { inputTokens: 25237, outputTokens: 112 },
    });
  });

  it("sums usage and counts turns across several completed turns", () => {
    const { acc } = feedAll([
      threadStarted,
      turnCompleted,
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const { event } = acc.finish();
    expect(event.turns).toBe(2);
    expect(event.usage).toEqual({ inputTokens: 25247, outputTokens: 117 });
  });

  it("omits usage entirely when no turn reported it", () => {
    const { acc } = feedAll([threadStarted, { type: "turn.completed" }]);
    const { event } = acc.finish();
    expect(event.turns).toBe(1);
    expect(event.usage).toBeUndefined();
  });

  it("turn.failed makes the synthesized result not-ok and carries the error message", () => {
    const { acc } = feedAll([
      threadStarted,
      { type: "turn.failed", error: { message: "model refused" } },
    ]);
    const outcome = acc.finish();
    expect(outcome.failure).toBe("model refused");
    expect(outcome.event.ok).toBe(false);
    expect(outcome.event.summary).toBe("model refused");
  });

  it("falls back to a generic message for a shapeless turn.failed", () => {
    const { acc } = feedAll([{ type: "turn.failed" }]);
    expect(acc.finish().failure).toBe("codex turn failed");
  });

  it("an error line is both forwarded and recorded as the failure", () => {
    const { events, acc } = feedAll([threadStarted, { type: "error", message: "stream broke" }]);
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "error"]);
    expect(acc.finish().event.ok).toBe(false);
  });

  it("keeps the last agent message when several arrive", () => {
    const { acc } = feedAll([
      agentMessage,
      { type: "item.completed", item: { type: "agent_message", text: "final word" } },
    ]);
    expect(acc.finish().resultText).toBe("final word");
  });

  it("caps the result summary at 2000 chars while resultText stays whole", () => {
    const big = "x".repeat(3000);
    const { acc } = feedAll([{ type: "item.completed", item: { type: "agent_message", text: big } }]);
    const outcome = acc.finish();
    expect(outcome.resultText).toBe(big);
    expect(outcome.event.summary!.length).toBe(2000);
  });

  it("omits the summary when the run produced neither message nor failure", () => {
    const { acc } = feedAll([threadStarted]);
    const { event } = acc.finish();
    expect(event.summary).toBeUndefined();
    expect(event.ok).toBe(true);
  });

  it("buffers NDJSON across chunk boundaries and flushes a trailing partial line", () => {
    const events: CodingEvent[] = [];
    const acc = createCodexRunAccumulator((e) => events.push(e));
    const stream = `${line(threadStarted)}${line(agentMessage)}`;
    acc.feed(stream.slice(0, 30));
    acc.feed(stream.slice(30, 90));
    acc.feed(stream.slice(90));
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "text"]);

    // A line with no trailing newline only lands on flush.
    acc.feed(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }));
    expect(acc.finish().event.turns).toBe(0);
    acc.flush();
    expect(acc.finish().event.turns).toBe(1);
  });

  it("skips blank and unparseable lines without crashing", () => {
    const events: CodingEvent[] = [];
    const acc = createCodexRunAccumulator((e) => events.push(e));
    acc.feed(`\n  \nnot json\n[1,2,3]\n${line(threadStarted)}`);
    acc.flush();
    expect(events).toEqual([{ kind: "agent-init", sessionId: THREAD_ID }]);
  });
});
