import { describe, it, expect } from "vitest";
import type { CodingEvent } from "@skipper/shared";
import { mapGeminiLine, createGeminiRunAccumulator } from "../src/llm/gemini-stream";

// DOCS-ONLY FIXTURES (#243 D2). The gemini CLI is not installed on this machine,
// so every line below is hand-built from the documented JsonStreamEvent union in
// the CLI source rather than captured from a real run. These fixtures pin the
// mapper's behavior, not the CLI's contract — if a real run disagrees, fix
// gemini-stream.ts and these fixtures together.
const SESSION_ID = "7f3a1c2e-9b4d-4e6a-8f1b-2c3d4e5f6a7b";
const initLine = { type: "init", timestamp: "2026-07-25T10:00:00Z", session_id: SESSION_ID, model: "gemini-2.5-pro" };
const assistantMessage = { type: "message", role: "assistant", content: "Fixed the failing test." };
const shellUse = {
  type: "tool_use",
  tool_name: "run_shell_command",
  tool_id: "call_1",
  parameters: { command: "pnpm test" },
};
const resultLine = {
  type: "result",
  status: "success",
  stats: { input_tokens: 4210, output_tokens: 180 },
};

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

function collect(chunks: string[], premintedSessionId?: string) {
  const events: CodingEvent[] = [];
  const acc = createGeminiRunAccumulator((e) => events.push(e), premintedSessionId);
  for (const chunk of chunks) acc.feed(chunk);
  acc.flush();
  return { events, outcome: acc.finish() };
}

describe("mapGeminiLine", () => {
  it("maps init to agent-init carrying the session id and model", () => {
    expect(mapGeminiLine(initLine)).toEqual({
      kind: "agent-init",
      sessionId: SESSION_ID,
      model: "gemini-2.5-pro",
    });
  });

  it("drops an init line with no session id, and omits an absent model", () => {
    expect(mapGeminiLine({ type: "init", model: "gemini-2.5-pro" })).toBeNull();
    expect(mapGeminiLine({ type: "init", session_id: SESSION_ID })).toEqual({
      kind: "agent-init",
      sessionId: SESSION_ID,
    });
  });

  it("maps an assistant message to an untruncated text event", () => {
    expect(mapGeminiLine(assistantMessage)).toEqual({
      kind: "text",
      text: "Fixed the failing test.",
    });
  });

  it("prefers the delta over the content when a line carries both", () => {
    expect(
      mapGeminiLine({ type: "message", role: "assistant", content: "Fixed the", delta: " test." }),
    ).toEqual({ kind: "text", text: " test." });
  });

  it("drops the echoed user message and a whitespace-only assistant one", () => {
    expect(mapGeminiLine({ type: "message", role: "user", content: "implement it" })).toBeNull();
    expect(mapGeminiLine({ type: "message", role: "assistant", content: "   " })).toBeNull();
    expect(mapGeminiLine({ type: "message", role: "assistant" })).toBeNull();
  });

  it("drops tool_result — a failed tool is the agent's problem, not the run's", () => {
    expect(mapGeminiLine({ type: "tool_result", tool_id: "call_1", status: "success" })).toBeNull();
    expect(
      mapGeminiLine({ type: "tool_result", tool_id: "call_1", status: "error", error: "boom" }),
    ).toBeNull();
  });

  it("maps run_shell_command to a Bash tool-use carrying the command", () => {
    expect(mapGeminiLine(shellUse)).toEqual({
      kind: "tool-use",
      tool: "Bash",
      detail: "pnpm test",
      input: JSON.stringify({ command: "pnpm test" }, null, 2),
    });
  });

  it("maps the write tools to Edit detailed with the file path", () => {
    for (const tool_name of ["write_file", "replace"]) {
      expect(
        mapGeminiLine({ type: "tool_use", tool_name, parameters: { file_path: "src/a.ts" } }),
      ).toMatchObject({ kind: "tool-use", tool: "Edit", detail: "src/a.ts" });
    }
  });

  it("maps the read, glob, grep and web tools to the console vocabulary", () => {
    const map = (tool_name: string, parameters: Record<string, unknown>) =>
      mapGeminiLine({ type: "tool_use", tool_name, parameters });
    expect(map("read_file", { absolute_path: "/repo/a.ts" })).toMatchObject({
      tool: "Read",
      detail: "/repo/a.ts",
    });
    expect(map("read_many_files", { paths: "src/**" })).toMatchObject({ tool: "Read" });
    expect(map("glob", { pattern: "**/*.ts" })).toMatchObject({
      tool: "Glob",
      detail: "**/*.ts",
    });
    expect(map("search_file_content", { pattern: "TODO" })).toMatchObject({
      tool: "Grep",
      detail: "TODO",
    });
    expect(map("grep", { pattern: "FIXME" })).toMatchObject({ tool: "Grep", detail: "FIXME" });
    expect(map("google_web_search", { query: "vitest fake timers" })).toMatchObject({
      tool: "WebSearch",
      detail: "vitest fake timers",
    });
    expect(map("web_fetch", { prompt: "summarize", url: "https://example.com" })).toMatchObject({
      tool: "WebFetch",
      detail: "summarize",
    });
  });

  // Gemini namespaces an MCP tool as mcp_<server>_<tool>; the console (and the
  // "memories used" card, #46) reads the claude-shaped mcp__server__tool.
  it("rewrites an MCP tool name to the mcp__server__tool form", () => {
    expect(
      mapGeminiLine({
        type: "tool_use",
        tool_name: "mcp_skipper-memory_search_memory",
        parameters: { query: "flaky worktree lock" },
      }),
    ).toEqual({
      kind: "tool-use",
      tool: "mcp__skipper-memory__search_memory",
      detail: "flaky worktree lock",
      input: JSON.stringify({ query: "flaky worktree lock" }, null, 2),
    });
    expect(
      mapGeminiLine({
        type: "tool_use",
        tool_name: "mcp_skipper-memory_get_memory",
        parameters: { id: "sol-42" },
      }),
    ).toMatchObject({ tool: "mcp__skipper-memory__get_memory", detail: "sol-42" });
  });

  it("leaves an already-claude-shaped MCP name alone", () => {
    expect(
      mapGeminiLine({
        type: "tool_use",
        tool_name: "mcp__skipper-memory__get_memory",
        parameters: { id: "sol-7" },
      }),
    ).toMatchObject({ tool: "mcp__skipper-memory__get_memory", detail: "sol-7" });
  });

  it("keeps an unrecognized tool name raw", () => {
    expect(
      mapGeminiLine({ type: "tool_use", tool_name: "save_memory", parameters: { fact: "x" } }),
    ).toMatchObject({ kind: "tool-use", tool: "save_memory" });
  });

  it("maps an error line to an error event, dropping warnings", () => {
    expect(mapGeminiLine({ type: "error", severity: "error", message: "quota exceeded" })).toEqual({
      kind: "error",
      message: "quota exceeded",
    });
    expect(mapGeminiLine({ type: "error", severity: "warning", message: "slow tool" })).toBeNull();
  });

  it("names a messageless error rather than dropping it", () => {
    expect(mapGeminiLine({ type: "error", severity: "error" })).toEqual({
      kind: "error",
      message: "gemini reported an error",
    });
  });

  it("returns null for unknown types, non-objects and malformed input", () => {
    expect(mapGeminiLine({ type: "thought", subject: "planning" })).toBeNull();
    expect(mapGeminiLine({ type: "result", status: "success" })).toBeNull();
    expect(mapGeminiLine(null)).toBeNull();
    expect(mapGeminiLine("not an object")).toBeNull();
    expect(mapGeminiLine([1, 2, 3])).toBeNull();
    expect(mapGeminiLine({})).toBeNull();
  });

  it("caps the tool detail at 120 chars and the input payload at 2000", () => {
    const event = mapGeminiLine({
      type: "tool_use",
      tool_name: "run_shell_command",
      parameters: { command: "x".repeat(500), blob: "y".repeat(4000) },
    }) as Extract<CodingEvent, { kind: "tool-use" }>;
    expect(event.detail).toHaveLength(120);
    expect(event.input).toHaveLength(2000);
  });
});

describe("createGeminiRunAccumulator", () => {
  it("forwards init, tool use and text, then synthesizes the result", () => {
    const { events, outcome } = collect([
      line(initLine),
      line(shellUse),
      line(assistantMessage),
      line(resultLine),
    ]);

    expect(events.map((e) => e.kind)).toEqual(["agent-init", "tool-use", "text"]);
    expect(outcome.event).toEqual({
      kind: "result",
      ok: true,
      summary: "Fixed the failing test.",
      usage: { inputTokens: 4210, outputTokens: 180 },
    });
    expect(outcome.sessionId).toBe(SESSION_ID);
    expect(outcome.resultText).toBe("Fixed the failing test.");
    expect(outcome.failure).toBeUndefined();
  });

  // No turn events exist in this stream, so a turn count would be invented
  // (stats.tool_calls is not turns) — the field is left off entirely (#243 D7).
  it("never reports a turn count", () => {
    const { outcome } = collect([line(assistantMessage), line(resultLine)]);
    expect("turns" in outcome.event).toBe(false);
  });

  it("concatenates deltas into one text event, flushed by the next non-message line", () => {
    const delta = (d: string) => line({ type: "message", role: "assistant", delta: d });
    const { events } = collect([
      delta("Fixed "),
      delta("the failing "),
      delta("test."),
      line(shellUse),
    ]);
    expect(events).toEqual([
      { kind: "text", text: "Fixed the failing test." },
      {
        kind: "tool-use",
        tool: "Bash",
        detail: "pnpm test",
        input: JSON.stringify({ command: "pnpm test" }, null, 2),
      },
    ]);
  });

  it("flushes a trailing delta buffer at finish, with no result line in sight", () => {
    const { events, outcome } = collect([
      line({ type: "message", role: "assistant", delta: "half a " }),
      line({ type: "message", role: "assistant", delta: "sentence" }),
    ]);
    expect(events).toEqual([{ kind: "text", text: "half a sentence" }]);
    expect(outcome.event).toEqual({ kind: "result", ok: true, summary: "half a sentence" });
    expect(outcome.resultText).toBe("half a sentence");
  });

  it("drops the echoed user message from the buffer", () => {
    const { events } = collect([
      line({ type: "message", role: "user", content: "implement it" }),
      line(assistantMessage),
      line(resultLine),
    ]);
    expect(events).toEqual([{ kind: "text", text: "Fixed the failing test." }]);
  });

  // The result line overrides the synthesized outcome rather than being the
  // outcome: a crash without one still produces exactly one result.
  it("lets a failed result line override ok, and names the failure", () => {
    const { outcome } = collect([
      line(assistantMessage),
      line({ type: "result", status: "error", error: { message: "model refused" } }),
    ]);
    expect(outcome.event.ok).toBe(false);
    expect(outcome.failure).toBe("model refused");
  });

  it("synthesizes a failure message from a non-success status with no error field", () => {
    const { outcome } = collect([line(assistantMessage), line({ type: "result", status: "cancelled" })]);
    expect(outcome.event.ok).toBe(false);
    expect(outcome.failure).toBe("gemini run ended with status cancelled");
  });

  it("synthesizes an ok result when the process died before any result line", () => {
    const { outcome } = collect([line(initLine), line(assistantMessage)]);
    expect(outcome.event).toEqual({
      kind: "result",
      ok: true,
      summary: "Fixed the failing test.",
    });
    expect(outcome.sessionId).toBe(SESSION_ID);
  });

  it("marks the run failed when the stream carried an error line", () => {
    const { events, outcome } = collect([
      line({ type: "error", severity: "error", message: "quota exceeded" }),
      line(resultLine),
    ]);
    expect(events).toEqual([{ kind: "error", message: "quota exceeded" }]);
    expect(outcome.event.ok).toBe(false);
    expect(outcome.event.summary).toBe("quota exceeded");
    expect(outcome.failure).toBe("quota exceeded");
  });

  it("keeps the pre-minted session id until the init event reports one", () => {
    const preminted = "11111111-1111-4111-8111-111111111111";
    expect(collect([line(assistantMessage)], preminted).outcome.sessionId).toBe(preminted);
    expect(collect([line(initLine), line(assistantMessage)], preminted).outcome.sessionId).toBe(
      SESSION_ID,
    );
  });

  it("reassembles lines split across chunk boundaries", () => {
    const whole = `${line(initLine)}${line(assistantMessage)}${line(resultLine)}`;
    const { events, outcome } = collect([whole.slice(0, 30), whole.slice(30, 90), whole.slice(90)]);
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "text"]);
    expect(outcome.event.ok).toBe(true);
    expect(outcome.event.usage).toEqual({ inputTokens: 4210, outputTokens: 180 });
  });

  it("survives malformed lines, blank lines and non-object JSON", () => {
    const { events, outcome } = collect([
      "\n",
      "{not json\n",
      "42\n",
      '"a string"\n',
      line(assistantMessage),
      line(resultLine),
    ]);
    expect(events).toEqual([{ kind: "text", text: "Fixed the failing test." }]);
    expect(outcome.event.ok).toBe(true);
  });

  it("emits an unterminated final line on flush", () => {
    const events: CodingEvent[] = [];
    const acc = createGeminiRunAccumulator((e) => events.push(e));
    acc.feed(JSON.stringify(assistantMessage)); // no trailing newline
    expect(events).toEqual([]);
    acc.flush();
    expect(events).toEqual([{ kind: "text", text: "Fixed the failing test." }]);
  });

  it("caps the result summary at 2000 chars while resultText stays whole", () => {
    const big = "x".repeat(3000);
    const { outcome } = collect([
      line({ type: "message", role: "assistant", content: big }),
      line(resultLine),
    ]);
    expect(outcome.event.summary).toHaveLength(2000);
    expect(outcome.resultText).toBe(big);
  });

  it("reads usage from the camelCase and prompt/completion spellings too", () => {
    const { outcome } = collect([
      line(assistantMessage),
      line({ type: "result", status: "success", stats: { promptTokens: 1, completion_tokens: 2 } }),
    ]);
    expect(outcome.event.usage).toBeUndefined();
    const { outcome: alt } = collect([
      line(assistantMessage),
      line({ type: "result", status: "success", stats: { prompt_tokens: 10, completion_tokens: 4 } }),
    ]);
    expect(alt.event.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});
