import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { CodingEvent } from "@skipper/shared";
import { ClaudeCLIProvider, invalidateResolvedClaude } from "../src/llm/claude-cli";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ""),
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    written: "",
    write(data: string) {
      this.written += data;
    },
    end: vi.fn(),
  };
}

function arm(): { child: FakeChild; argv: () => string[] } {
  const child = new FakeChild();
  vi.mocked(spawn).mockImplementation(() => child as never);
  return {
    child,
    argv: () => vi.mocked(spawn).mock.calls[0][1] as string[],
  };
}

const initLine = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "11111111-1111-4111-8111-111111111111",
});
const assistantLine = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Exploring the repo." },
      { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
    ],
  },
});
const LONG_RESULT = `{"plan": "${"x".repeat(4000)}"}`;
const resultLine = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: LONG_RESULT,
  num_turns: 7,
  usage: { input_tokens: 100, output_tokens: 200 },
});

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  invalidateResolvedClaude();
});

describe("ClaudeCLIProvider.agent", () => {
  it("without onEvent uses buffered json output", async () => {
    const { child, argv } = arm();
    const promise = new ClaudeCLIProvider("sonnet").agent("plan it");
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 2 } })),
    );
    child.emit("close", 0);
    const res = await promise;

    const joined = argv().join(" ");
    expect(joined).toContain("--output-format json");
    expect(argv()).not.toContain("--verbose");
    expect(res).toEqual({ text: "done", usage: { inputTokens: 1, outputTokens: 2 } });
  });

  it("with onEvent streams events and returns the full untruncated result", async () => {
    const events: CodingEvent[] = [];
    const { child, argv } = arm();
    const promise = new ClaudeCLIProvider("sonnet").agent("plan it", {
      onEvent: (e) => events.push(e),
    });
    // Split across chunk boundaries to exercise the NDJSON buffer.
    const stream = `${initLine}\n${assistantLine}\n${resultLine}\n`;
    child.stdout.emit("data", Buffer.from(stream.slice(0, 40)));
    child.stdout.emit("data", Buffer.from(stream.slice(40)));
    child.emit("close", 0);
    const res = await promise;

    const joined = argv().join(" ");
    expect(joined).toContain("--output-format stream-json");
    expect(argv()).toContain("--verbose");
    expect(argv()).toContain("--no-session-persistence");
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "text", "tool-use", "result"]);
    expect(res.text).toBe(LONG_RESULT); // raw line, not the 2000-char event summary
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
    expect(res.sessionId).toBeUndefined(); // #111: no id without persistence
  });

  // #111: passing sessionId persists the run under it — the flag swaps and the
  // returned id is the CLI's own init-line session (authoritative on disk).
  it("with sessionId persists the session and returns the init-line id", async () => {
    const { child, argv } = arm();
    const minted = "22222222-2222-4222-8222-222222222222";
    const promise = new ClaudeCLIProvider("sonnet").agent("plan it", {
      onEvent: () => {},
      sessionId: minted,
    });
    child.stdout.emit("data", Buffer.from(`${initLine}\n${resultLine}\n`));
    child.emit("close", 0);
    const res = await promise;

    expect(argv()).toContain("--session-id");
    expect(argv()).toContain(minted);
    expect(argv()).not.toContain("--no-session-persistence");
    expect(res.sessionId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("appends the guard hook + confined env when confinement carries a CLI bundle (#196)", async () => {
    const { child } = arm();
    const spawnOpts = () => vi.mocked(spawn).mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
    const argv = () => vi.mocked(spawn).mock.calls[0][1] as string[];
    const promise = new ClaudeCLIProvider("sonnet").agent("plan it", {
      confinement: {
        runRoot: "/wt/issue-1",
        denyRoots: ["/home/me/repo"],
        cliBundlePath: "/app/skipper.bundle.cjs",
      },
    });
    child.stdout.emit("data", Buffer.from(JSON.stringify({ is_error: false, result: "done" })));
    child.emit("close", 0);
    await promise;

    const args = argv();
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher)).toEqual([
      "Edit|Write",
      "Bash",
    ]);
    expect(spawnOpts().env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("streaming rejects on an error result", async () => {
    const { child } = arm();
    const promise = new ClaudeCLIProvider("sonnet").agent("plan it", { onEvent: () => {} });
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "result", is_error: true, result: "over budget" })}\n`),
    );
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/Claude CLI error: over budget/);
  });

  it("streaming rejects when the stream ends without a result", async () => {
    const { child } = arm();
    const promise = new ClaudeCLIProvider("sonnet").agent("plan it", { onEvent: () => {} });
    child.stdout.emit("data", Buffer.from(`${initLine}\n`));
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/stream ended without a result/);
  });
});

describe("ClaudeCLIProvider.askStructured", () => {
  const schema = { type: "object" } as Record<string, unknown>;
  const reply = JSON.stringify({ is_error: false, result: '{"ok":true}' });
  const spawnOpts = () => vi.mocked(spawn).mock.calls[0][2] as { cwd?: string };

  it("without opts stays stateless and runs in tmpdir", async () => {
    const { child, argv } = arm();
    const promise = new ClaudeCLIProvider("sonnet").askStructured("q", schema);
    child.stdout.emit("data", Buffer.from(reply));
    child.emit("close", 0);
    const res = await promise;

    expect(argv()).toContain("--no-session-persistence");
    expect(argv()).not.toContain("--session-id");
    expect(spawnOpts().cwd).toBe(tmpdir());
    expect(res).toEqual({ ok: true });
  });

  // #111: opts persist the structured call under a session and pin its cwd so the
  // on-disk session lands in the worktree.
  it("with opts persists the session and runs in opts.cwd", async () => {
    const { child, argv } = arm();
    const promise = new ClaudeCLIProvider("sonnet").askStructured("q", schema, {
      cwd: "/wt/issue-1",
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
    child.stdout.emit("data", Buffer.from(reply));
    child.emit("close", 0);
    await promise;

    expect(argv()).toContain("--session-id");
    expect(argv()).toContain("33333333-3333-4333-8333-333333333333");
    expect(argv()).not.toContain("--no-session-persistence");
    expect(spawnOpts().cwd).toBe("/wt/issue-1");
  });
});
