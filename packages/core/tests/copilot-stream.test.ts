import { describe, it, expect } from "vitest";
import type { CodingEvent } from "@skipper/shared";
import { mapCopilotLine, createCopilotRunAccumulator } from "../src/llm/copilot-stream";

// BEST-EFFORT FIXTURES (#242). The copilot CLI's `--output-format json` schema is
// undocumented (github/copilot-cli#3551): the event *types* below come from
// community captures, the field names are the mapper's guesses. These fixtures
// pin the mapper's behavior, not the CLI's contract — when a real run shows the
// true field names, fix the helper in copilot-stream.ts and the fixtures here.
const SESSION_ID = "7f3a1c2e-9b4d-4e6a-8f1b-2c3d4e5f6a7b";
const assistantMessage = { type: "assistant.message", text: "Fixed the failing test." };
const shellStart = {
  type: "tool.execution_start",
  tool_name: "shell",
  arguments: { command: "pnpm test" },
};
const turnEnd = {
  type: "assistant.turn_end",
  usage: { input_tokens: 4210, output_tokens: 180 },
};

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

describe("mapCopilotLine", () => {
  it("maps assistant.message to an untruncated text event", () => {
    expect(mapCopilotLine(assistantMessage)).toEqual({
      kind: "text",
      text: "Fixed the failing test.",
    });
  });

  it("reads the message text from any of the candidate keys", () => {
    expect(mapCopilotLine({ type: "assistant.message", content: "from content" })).toEqual({
      kind: "text",
      text: "from content",
    });
    expect(
      mapCopilotLine({ type: "assistant.message", message: { content: "from message.content" } }),
    ).toEqual({ kind: "text", text: "from message.content" });
  });

  it("drops a whitespace-only or textless assistant.message", () => {
    expect(mapCopilotLine({ type: "assistant.message", text: "   " })).toBeNull();
    expect(mapCopilotLine({ type: "assistant.message" })).toBeNull();
  });

  // The full text arrives on assistant.message; streaming the deltas too would
  // duplicate every sentence in the console.
  it("drops the streaming deltas, turn_start and the echoed user message", () => {
    expect(mapCopilotLine({ type: "assistant.message_start" })).toBeNull();
    expect(mapCopilotLine({ type: "assistant.message_delta", text: "Fix" })).toBeNull();
    expect(mapCopilotLine({ type: "assistant.reasoning_delta", text: "thinking" })).toBeNull();
    expect(mapCopilotLine({ type: "assistant.turn_start" })).toBeNull();
    expect(mapCopilotLine({ type: "user.message", text: "implement it" })).toBeNull();
  });

  it("maps a shell tool.execution_start to a Bash tool-use carrying the command", () => {
    expect(mapCopilotLine(shellStart)).toEqual({
      kind: "tool-use",
      tool: "Bash",
      detail: "pnpm test",
      input: JSON.stringify({ command: "pnpm test" }, null, 2),
    });
  });

  it("maps the write and edit tool kinds to Write/Edit detailed with the path", () => {
    expect(
      mapCopilotLine({
        type: "tool.execution_start",
        tool_name: "write_file",
        arguments: { path: "src/a.ts", content: "x" },
      }),
    ).toMatchObject({ kind: "tool-use", tool: "Write", detail: "src/a.ts" });
    expect(
      mapCopilotLine({
        type: "tool.execution_start",
        tool_name: "str_replace_editor",
        arguments: { file_path: "src/b.ts" },
      }),
    ).toMatchObject({ kind: "tool-use", tool: "Edit", detail: "src/b.ts" });
  });

  it("maps an MCP tool to the mcp__server__tool name (#46 memory card)", () => {
    expect(
      mapCopilotLine({
        type: "tool.execution_start",
        server: "skipper-memory",
        tool_name: "get_memory",
        arguments: { id: "sol-42" },
      }),
    ).toEqual({
      kind: "tool-use",
      tool: "mcp__skipper-memory__get_memory",
      detail: "sol-42",
      input: JSON.stringify({ id: "sol-42" }, null, 2),
    });
  });

  it("prefers the query argument over id for the mcp detail", () => {
    expect(
      mapCopilotLine({
        type: "tool.execution_start",
        server: "skipper-memory",
        tool_name: "search_memory",
        arguments: { query: "flaky worktree lock", id: "ignored" },
      }),
    ).toMatchObject({
      tool: "mcp__skipper-memory__search_memory",
      detail: "flaky worktree lock",
    });
  });

  it("keeps an unrecognized tool name raw", () => {
    expect(
      mapCopilotLine({
        type: "tool.execution_start",
        tool_name: "fetch_url",
        arguments: { url: "https://example.com" },
      }),
    ).toMatchObject({ kind: "tool-use", tool: "fetch_url" });
  });

  it("reads the tool name and arguments from any of the candidate keys", () => {
    expect(
      mapCopilotLine({ type: "tool.execution_start", name: "bash", input: { cmd: "ls" } }),
    ).toMatchObject({ tool: "Bash", detail: "ls" });
    expect(
      mapCopilotLine({
        type: "tool.execution_start",
        tool: { name: "shell", arguments: { command: "ls -la" } },
      }),
    ).toMatchObject({ tool: "Bash", detail: "ls -la" });
  });

  it("drops a completed tool execution so a tool logs once", () => {
    expect(
      mapCopilotLine({ type: "tool.execution_complete", tool_name: "shell", exit_code: 0 }),
    ).toBeNull();
  });

  it("drops the compaction, subagent, skill and hook side channels", () => {
    expect(mapCopilotLine({ type: "session.compaction_start" })).toBeNull();
    expect(mapCopilotLine({ type: "session.compaction_end" })).toBeNull();
    expect(mapCopilotLine({ type: "subagent.started", name: "explorer" })).toBeNull();
    expect(mapCopilotLine({ type: "skill.invoked", name: "review" })).toBeNull();
    expect(mapCopilotLine({ type: "hook.pre_tool_use" })).toBeNull();
  });

  // A failure inside a side channel is an internal detail of the run, not the
  // run's own failure — the guard keeps it out of the error path entirely.
  it("drops a side-channel line even when it reports a failure", () => {
    expect(
      mapCopilotLine({ type: "session.compaction_failed", error: { message: "too big" } }),
    ).toBeNull();
    expect(mapCopilotLine({ type: "subagent.failed", message: "sub died" })).toBeNull();
  });

  it("drops the abort line — it is recorded as a failure, not shown as an error", () => {
    expect(mapCopilotLine({ type: "abort", reason: "user cancelled" })).toBeNull();
  });

  it("maps error-shaped lines to an error event", () => {
    expect(mapCopilotLine({ type: "error", message: "stream broke" })).toEqual({
      kind: "error",
      message: "stream broke",
    });
    expect(
      mapCopilotLine({ type: "assistant.turn_failed", error: { message: "model refused" } }),
    ).toEqual({ kind: "error", message: "model refused" });
    expect(mapCopilotLine({ type: "error", error: "rate limited" })).toEqual({
      kind: "error",
      message: "rate limited",
    });
  });

  it("falls back to a generic message for a shapeless error line", () => {
    expect(mapCopilotLine({ type: "error" })).toEqual({
      kind: "error",
      message: "copilot reported an error",
    });
  });

  it("never crashes on malformed input", () => {
    expect(mapCopilotLine(null)).toBeNull();
    expect(mapCopilotLine("not an object")).toBeNull();
    expect(mapCopilotLine(42)).toBeNull();
    expect(mapCopilotLine([1, 2, 3])).toBeNull();
    expect(mapCopilotLine({})).toBeNull();
    expect(mapCopilotLine({ type: "tool.execution_start" })).toBeNull();
    expect(mapCopilotLine({ type: "future.event", payload: { deep: true } })).toBeNull();
  });

  it("caps the tool detail at 120 chars and the input payload at 2000", () => {
    const command = "x".repeat(5000);
    const event = mapCopilotLine({
      type: "tool.execution_start",
      tool_name: "shell",
      arguments: { command },
    }) as Extract<CodingEvent, { kind: "tool-use" }>;
    expect(event.detail!.length).toBe(120);
    expect(event.input!.length).toBe(2000);
  });
});

describe("createCopilotRunAccumulator", () => {
  function feedAll(
    lines: unknown[],
    premintedSessionId?: string,
  ): { events: CodingEvent[]; acc: ReturnType<typeof createCopilotRunAccumulator> } {
    const events: CodingEvent[] = [];
    const acc = createCopilotRunAccumulator((e) => events.push(e), premintedSessionId);
    for (const l of lines) acc.feed(line(l));
    acc.flush();
    return { events, acc };
  }

  // Copilot echoes no init line, so the id the run was started with is announced
  // on the first line that parses — whatever that line happens to be.
  it("synthesizes agent-init from the pre-minted id on the first parsed line", () => {
    const { events, acc } = feedAll([assistantMessage, turnEnd], SESSION_ID);
    expect(events[0]).toEqual({ kind: "agent-init", sessionId: SESSION_ID });
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "text"]);
    expect(acc.finish().sessionId).toBe(SESSION_ID);
  });

  it("announces agent-init exactly once across a long stream", () => {
    const { events } = feedAll([shellStart, assistantMessage, turnEnd], SESSION_ID);
    expect(events.filter((e) => e.kind === "agent-init")).toHaveLength(1);
  });

  it("a stream-carried session id wins over the pre-minted one", () => {
    const carried = "11111111-1111-4111-8111-111111111111";
    const { events, acc } = feedAll(
      [{ type: "assistant.turn_start", session_id: carried }, assistantMessage],
      SESSION_ID,
    );
    expect(events[0]).toEqual({ kind: "agent-init", sessionId: carried });
    expect(acc.finish().sessionId).toBe(carried);
  });

  it("still reports a later-carried id on the outcome without re-announcing init", () => {
    const carried = "22222222-2222-4222-8222-222222222222";
    const { events, acc } = feedAll(
      [assistantMessage, { type: "assistant.turn_end", sessionId: carried }],
      SESSION_ID,
    );
    expect(events.filter((e) => e.kind === "agent-init")).toEqual([
      { kind: "agent-init", sessionId: SESSION_ID },
    ]);
    expect(acc.finish().sessionId).toBe(carried);
  });

  it("emits no agent-init at all when neither a pre-minted nor a carried id exists", () => {
    const { events, acc } = feedAll([assistantMessage]);
    expect(events.map((e) => e.kind)).toEqual(["text"]);
    expect(acc.finish().sessionId).toBeUndefined();
  });

  it("counts a turn per assistant.turn_end and sums the reported usage", () => {
    const { acc } = feedAll(
      [turnEnd, { type: "assistant.turn_end", usage: { input_tokens: 10, output_tokens: 5 } }],
      SESSION_ID,
    );
    const { event } = acc.finish();
    expect(event.turns).toBe(2);
    expect(event.usage).toEqual({ inputTokens: 4220, outputTokens: 185 });
  });

  it("omits usage entirely when no line reported any", () => {
    const { acc } = feedAll([{ type: "assistant.turn_end" }], SESSION_ID);
    const { event } = acc.finish();
    expect(event.turns).toBe(1);
    expect(event.usage).toBeUndefined();
  });

  it("harvests usage off a completed tool execution too", () => {
    const { acc } = feedAll(
      [
        {
          type: "tool.execution_complete",
          tool_name: "shell",
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      ],
      SESSION_ID,
    );
    expect(acc.finish().event.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  // Regression: a failing command is normal agent life (run tests → they fail →
  // the agent fixes them). It must never poison the run's own outcome.
  it("a failed tool execution does not fail the run", () => {
    const { events, acc } = feedAll(
      [
        shellStart,
        {
          type: "tool.execution_complete",
          tool_name: "shell",
          exit_code: 1,
          is_error: true,
          error: { message: "2 tests failed" },
        },
        assistantMessage,
      ],
      SESSION_ID,
    );
    const outcome = acc.finish();
    expect(outcome.failure).toBeUndefined();
    expect(outcome.event.ok).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "tool-use", "text"]);
  });

  it("synthesizes an ok result from the stream when no result line arrives", () => {
    const { acc } = feedAll([shellStart, assistantMessage, turnEnd], SESSION_ID);
    const outcome = acc.finish();
    expect(outcome.resultText).toBe("Fixed the failing test.");
    expect(outcome.failure).toBeUndefined();
    expect(outcome.event).toEqual({
      kind: "result",
      ok: true,
      summary: "Fixed the failing test.",
      turns: 1,
      usage: { inputTokens: 4210, outputTokens: 180 },
    });
  });

  it("a result line overrides the synthesized summary, turns and usage", () => {
    const { events, acc } = feedAll(
      [
        assistantMessage,
        turnEnd,
        {
          type: "result",
          result: "All done, 3 files touched.",
          num_turns: 9,
          usage: { input_tokens: 99, output_tokens: 11 },
        },
      ],
      SESSION_ID,
    );
    // The result line itself is never forwarded — the terminal event is minted once.
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "text"]);
    const outcome = acc.finish();
    expect(outcome.event).toEqual({
      kind: "result",
      ok: true,
      summary: "All done, 3 files touched.",
      turns: 9,
      usage: { inputTokens: 99, outputTokens: 11 },
    });
    // resultText stays the agent's own last message, not the result summary.
    expect(outcome.resultText).toBe("Fixed the failing test.");
  });

  it("a result line reporting an error makes the outcome not-ok", () => {
    const { acc } = feedAll(
      [assistantMessage, { type: "result", is_error: true, result: "hit the rate limit" }],
      SESSION_ID,
    );
    const outcome = acc.finish();
    expect(outcome.event.ok).toBe(false);
    expect(outcome.event.summary).toBe("hit the rate limit");
    expect(outcome.failure).toBe("copilot reported an error");
  });

  it("keeps the synthesized state when the process crashed before any result line", () => {
    const { acc } = feedAll([shellStart, assistantMessage], SESSION_ID);
    const outcome = acc.finish();
    expect(outcome.event).toEqual({
      kind: "result",
      ok: true,
      summary: "Fixed the failing test.",
      turns: 0,
    });
  });

  it("an abort line makes the result not-ok and carries the reason", () => {
    const { acc } = feedAll([assistantMessage, { type: "abort", reason: "user cancelled" }], SESSION_ID);
    const outcome = acc.finish();
    expect(outcome.failure).toBe("user cancelled");
    expect(outcome.event.ok).toBe(false);
  });

  it("falls back to a generic reason for a shapeless abort", () => {
    const { acc } = feedAll([{ type: "abort" }], SESSION_ID);
    expect(acc.finish().failure).toBe("copilot run aborted");
  });

  it("an error line is both forwarded and recorded as the failure", () => {
    const { events, acc } = feedAll([{ type: "error", message: "stream broke" }], SESSION_ID);
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "error"]);
    const outcome = acc.finish();
    expect(outcome.failure).toBe("stream broke");
    expect(outcome.event.ok).toBe(false);
    expect(outcome.event.summary).toBe("stream broke");
  });

  // A success flag on the result line must not erase a failure the stream showed:
  // reporting a broken run as green is worse than ignoring the override.
  it("an observed failure wins over a result line claiming success", () => {
    const { acc } = feedAll(
      [
        { type: "error", message: "stream broke" },
        { type: "result", is_error: false, result: "finished" },
      ],
      SESSION_ID,
    );
    const outcome = acc.finish();
    expect(outcome.event.ok).toBe(false);
    expect(outcome.failure).toBe("stream broke");
  });

  it("keeps the last agent message when several arrive", () => {
    const { acc } = feedAll(
      [assistantMessage, { type: "assistant.message", text: "final word" }],
      SESSION_ID,
    );
    expect(acc.finish().resultText).toBe("final word");
  });

  it("caps the result summary at 2000 chars while resultText stays whole", () => {
    const big = "x".repeat(3000);
    const { acc } = feedAll([{ type: "assistant.message", text: big }], SESSION_ID);
    const outcome = acc.finish();
    expect(outcome.resultText).toBe(big);
    expect(outcome.event.summary!.length).toBe(2000);
  });

  it("omits the summary when the run produced neither message nor failure", () => {
    const { acc } = feedAll([turnEnd], SESSION_ID);
    const { event } = acc.finish();
    expect(event.summary).toBeUndefined();
    expect(event.ok).toBe(true);
  });

  it("buffers JSONL across chunk boundaries and flushes a trailing partial line", () => {
    const events: CodingEvent[] = [];
    const acc = createCopilotRunAccumulator((e) => events.push(e), SESSION_ID);
    const stream = `${line(shellStart)}${line(assistantMessage)}`;
    acc.feed(stream.slice(0, 25));
    acc.feed(stream.slice(25, 80));
    acc.feed(stream.slice(80));
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "tool-use", "text"]);

    // A line with no trailing newline only lands on flush.
    acc.feed(JSON.stringify(turnEnd));
    expect(acc.finish().event.turns).toBe(0);
    acc.flush();
    expect(acc.finish().event.turns).toBe(1);
  });

  it("skips blank and unparseable lines without crashing", () => {
    const events: CodingEvent[] = [];
    const acc = createCopilotRunAccumulator((e) => events.push(e), SESSION_ID);
    acc.feed(`\n  \nnot json\n[1,2,3]\n${line(assistantMessage)}`);
    acc.flush();
    expect(events).toEqual([
      { kind: "agent-init", sessionId: SESSION_ID },
      { kind: "text", text: "Fixed the failing test." },
    ]);
  });
});
