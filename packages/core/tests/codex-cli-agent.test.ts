import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { CodingEvent } from "@skipper/shared";
import { CodexCLIProvider, invalidateResolvedCodex } from "../src/llm/codex-cli";

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

function arm(): { child: FakeChild; argv: () => string[]; opts: () => Record<string, unknown> } {
  const child = new FakeChild();
  vi.mocked(spawn).mockImplementation(() => child as never);
  return {
    child,
    argv: () => vi.mocked(spawn).mock.calls[0][1] as string[],
    opts: () => vi.mocked(spawn).mock.calls[0][2] as Record<string, unknown>,
  };
}

/** codex writes the final message to the -o path; emulate that. */
function writeLastMessage(argv: string[], text: string) {
  const outFile = argv[argv.indexOf("-o") + 1];
  writeFileSync(outFile, text, "utf-8");
}

const lines = (...l: string[]) => l.join("\n") + "\n";
const started = `{"type":"thread.started","thread_id":"019f-abc"}`;
const message = (t: string) =>
  `{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":${JSON.stringify(t)}}}`;
const completed = `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":200}}`;

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  invalidateResolvedCodex();
});

describe("CodexCLIProvider.agent", () => {
  it("streams events and returns the untruncated -o text", async () => {
    const { child, argv } = arm();
    const events: CodingEvent[] = [];
    const provider = new CodexCLIProvider("gpt-5.6-sol");
    const p = provider.agent("plan it", { cwd: "/repo", onEvent: (e) => events.push(e) });

    const long = `{"plan":"${"x".repeat(4000)}"}`;
    writeLastMessage(argv(), long);
    child.stdout.emit("data", Buffer.from(lines(started, message("short summary"), completed)));
    child.emit("close", 0);

    const res = await p;
    // -o carries the full text; the mapped result summary is capped.
    expect(res.text).toBe(long);
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "text", "result"]);
  });

  it("never lets the user's config or the repo's AGENTS.md hijack the run", async () => {
    const { child, argv } = arm();
    const provider = new CodexCLIProvider("gpt-5.6-sol");
    const p = provider.agent("plan it", { cwd: "/repo", systemPrompt: "be terse" });
    writeLastMessage(argv(), "ok");
    child.stdout.emit("data", Buffer.from(lines(started, completed)));
    child.emit("close", 0);
    await p;

    const args = argv();
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("project_doc_max_bytes=0");
    expect(args).toContain("--json");
    expect(args).toContain("--ephemeral");
    // The planner must not be able to write.
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain(`developer_instructions="be terse"`);
  });

  it("sends the prompt on stdin and closes it — an open pipe deadlocks codex", async () => {
    const { child, argv } = arm();
    const provider = new CodexCLIProvider();
    const p = provider.agent("the prompt", { cwd: "/repo" });
    writeLastMessage(argv(), "ok");
    child.stdout.emit("data", Buffer.from(lines(started, completed)));
    child.emit("close", 0);
    await p;

    expect(argv().at(-1)).toBe("-");
    expect(child.stdin.written).toBe("the prompt");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("omits --model when blank rather than sending an empty one", async () => {
    // A ChatGPT-plan account 400s on any explicit model, including "".
    const { child, argv } = arm();
    const p = new CodexCLIProvider("").agent("plan it", { cwd: "/repo" });
    writeLastMessage(argv(), "ok");
    child.stdout.emit("data", Buffer.from(lines(started, completed)));
    child.emit("close", 0);
    await p;
    expect(argv()).not.toContain("--model");

    vi.mocked(spawn).mockReset();
    const second = arm();
    const p2 = new CodexCLIProvider("gpt-5.6-sol").agent("plan it", { cwd: "/repo" });
    writeLastMessage(second.argv(), "ok");
    second.child.stdout.emit("data", Buffer.from(lines(started, completed)));
    second.child.emit("close", 0);
    await p2;
    expect(second.argv()[second.argv().indexOf("--model") + 1]).toBe("gpt-5.6-sol");
  });

  it("rejects a failed turn even though codex may exit 0", async () => {
    const { child } = arm();
    const provider = new CodexCLIProvider();
    const p = provider.agent("plan it", { cwd: "/repo" });
    child.stdout.emit(
      "data",
      Buffer.from(lines(started, `{"type":"turn.failed","error":{"message":"401 Unauthorized"}}`)),
    );
    child.emit("close", 0);
    await expect(p).rejects.toThrow(/401 Unauthorized/);
  });

  it("rejects an empty stdout rather than reporting an empty answer", async () => {
    const { child } = arm();
    const provider = new CodexCLIProvider();
    const p = provider.agent("plan it", { cwd: "/repo" });
    child.emit("close", 0);
    await expect(p).rejects.toThrow(/without a result/);
  });

  it("explains itself when codex is not installed", async () => {
    const { child } = arm();
    const provider = new CodexCLIProvider();
    const p = provider.agent("plan it");
    child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));
    await expect(p).rejects.toThrow(/not installed or not in your PATH/);
  });
});

describe("CodexCLIProvider.askStructured", () => {
  it("constrains the reply with --output-schema instead of inlining it", async () => {
    const { child, argv } = arm();
    const provider = new CodexCLIProvider();
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const p = provider.askStructured<{ ok: boolean }>("rate it", schema);

    writeLastMessage(argv(), `{"ok":true}`);
    child.stdout.emit("data", Buffer.from(lines(started, completed)));
    child.emit("close", 0);

    expect(await p).toEqual({ ok: true });
    // The prompt stays clean — no schema text appended, unlike the claude path.
    expect(child.stdin.written).toBe("rate it");
    expect(argv()).toContain("--output-schema");
  });

  it("still tolerates a fenced reply", async () => {
    const { child, argv } = arm();
    const provider = new CodexCLIProvider();
    const p = provider.askStructured<{ ok: boolean }>("rate it", {});
    writeLastMessage(argv(), '```json\n{"ok":false}\n```');
    child.stdout.emit("data", Buffer.from(lines(started, completed)));
    child.emit("close", 0);
    expect(await p).toEqual({ ok: false });
  });
});
