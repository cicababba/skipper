import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodingEvent } from "@skipper/shared";
import {
  CodexCli,
  CodexCliError,
  buildSystemPromptArgs,
  codexConfigArgs,
  invalidateResolvedCodex,
  resolveCodex,
  tomlValue,
} from "../src/llm/codex-cli";
import { AgentAbortError } from "../src/llm/provider";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ""),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { written: "", write(data: string) { this.written += data; }, end: vi.fn() };
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

function arm(): { child: FakeChild; argv: () => string[] } {
  const child = new FakeChild();
  vi.mocked(spawn).mockImplementation(() => child as never);
  return { child, argv: () => vi.mocked(spawn).mock.calls[0][1] as string[] };
}

const spawnOpts = () => vi.mocked(spawn).mock.calls[0][2] as { cwd?: string; env?: NodeJS.ProcessEnv };
const flagValue = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

const THREAD_ID = "019f99b6-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const threadLine = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID });
const commandLine = JSON.stringify({
  type: "item.started",
  item: { type: "command_execution", command: "/usr/bin/zsh -lc ls" },
});
const turnLine = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 25237, cached_input_tokens: 12032, output_tokens: 112 },
});
const messageLine = (text: string) =>
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
const okStream = `${threadLine}\n${commandLine}\n${messageLine("planned")}\n${turnLine}\n`;

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(execSync).mockReset();
  vi.mocked(execSync).mockReturnValue("" as never);
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
  invalidateResolvedCodex();
});

describe("CodexCli.agent", () => {
  it("runs read-only and ephemeral, returning the last agent message and summed usage", async () => {
    const { child, argv } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("plan it");
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;

    const args = argv();
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(flagValue(args, "--model")).toBe("gpt-5-codex");
    expect(flagValue(args, "--sandbox")).toBe("read-only");
    expect(args).toContain("--ephemeral");
    expect(args).not.toContain("-C");
    expect(args[args.length - 1]).toBe("-");
    expect(spawnOpts().cwd).toBe(tmpdir());
    expect(child.stdin.written).toBe("plan it");
    expect(res).toEqual({ text: "planned", usage: { inputTokens: 25237, outputTokens: 112 } });
    expect(res.sessionId).toBeUndefined();
  });

  it("omits --model when the runtime was constructed without one", async () => {
    const { child, argv } = arm();
    const promise = new CodexCli().agent("plan it");
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(argv()).not.toContain("--model");
  });

  it("forwards stream events to onEvent, chunk boundaries included", async () => {
    const events: CodingEvent[] = [];
    const { child } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("plan it", { onEvent: (e) => events.push(e) });
    child.stdout.emit("data", Buffer.from(okStream.slice(0, 45)));
    child.stdout.emit("data", Buffer.from(okStream.slice(45)));
    child.emit("close", 0);
    await promise;
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "tool-use", "text"]);
    expect(events[0]).toEqual({ kind: "agent-init", sessionId: THREAD_ID });
  });

  // Codex mints its own id: a pre-minted sessionId only means "persist this run",
  // and the id that comes back is the thread id off the stream.
  it("with sessionId drops --ephemeral and returns the minted thread id", async () => {
    const { child, argv } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("plan it", {
      sessionId: "22222222-2222-4222-8222-222222222222",
    });
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;
    expect(argv()).not.toContain("--ephemeral");
    expect(argv()).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(res.sessionId).toBe(THREAD_ID);
  });

  it("resumes through the resume subcommand and pins cwd with -C", async () => {
    const { child, argv } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("continue", {
      resumeSessionId: THREAD_ID,
      cwd: "/wt/issue-1",
    });
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;
    expect(argv().slice(0, 3)).toEqual(["exec", "resume", THREAD_ID]);
    expect(argv()).not.toContain("--ephemeral");
    expect(flagValue(argv(), "-C")).toBe("/wt/issue-1");
    expect(spawnOpts().cwd).toBe("/wt/issue-1");
    expect(res.sessionId).toBe(THREAD_ID);
  });

  it("falls back to the resumed id when the stream carried no thread.started", async () => {
    const { child } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("continue", { resumeSessionId: THREAD_ID });
    child.stdout.emit("data", Buffer.from(`${messageLine("ok")}\n`));
    child.emit("close", 0);
    expect((await promise).sessionId).toBe(THREAD_ID);
  });

  it("injects the memory MCP server and the system prompt as -c overrides", async () => {
    const { child, argv } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("plan it", {
      systemPrompt: "be terse",
      memory: { cliBundlePath: "/app/skipper.bundle.cjs", repo: { owner: "Cicababba", name: "Skipper" } },
    });
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(argv()).toContain('developer_instructions="be terse"');
    expect(argv()).toContain('mcp_servers.skipper-memory.env={ELECTRON_RUN_AS_NODE="1"}');
  });

  it("throws a CodexCliError when a turn fails", async () => {
    const { child } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("plan it");
    child.stdout.emit(
      "data",
      Buffer.from(`${threadLine}\n${JSON.stringify({ type: "turn.failed", error: { message: "over budget" } })}\n`),
    );
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/Codex CLI error: over budget/);
  });

  it("explains how to install codex when the binary is missing", async () => {
    const { child } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("plan it");
    const err: NodeJS.ErrnoException = new Error("spawn codex ENOENT");
    err.code = "ENOENT";
    child.emit("error", err);
    await expect(promise).rejects.toThrow(/Codex CLI is not installed.*npm install -g @openai\/codex/s);
  });
});

describe("CodexCli.agent guards", () => {
  it("kills a silent run past inactivityTimeoutMs with subtype error_inactivity", async () => {
    vi.useFakeTimers();
    try {
      const { child } = arm();
      const promise = new CodexCli("gpt-5-codex").agent("plan it", {
        inactivityTimeoutMs: 1000,
        hardTimeoutMs: 60_000,
      });
      const settled = promise.catch((e) => e);
      child.stdout.emit("data", Buffer.from(`${threadLine}\n`)); // arms, then goes silent
      vi.advanceTimersByTime(1001);
      const err = await settled;
      expect(err).toBeInstanceOf(CodexCliError);
      expect((err as CodexCliError).subtype).toBe("error_inactivity");
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a chatty run past hardTimeoutMs with subtype error_hard_timeout", async () => {
    vi.useFakeTimers();
    try {
      const { child } = arm();
      const promise = new CodexCli("gpt-5-codex").agent("plan it", {
        inactivityTimeoutMs: 60_000,
        hardTimeoutMs: 2000,
      });
      const settled = promise.catch((e) => e);
      vi.advanceTimersByTime(1500);
      child.stdout.emit("data", Buffer.from(`${threadLine}\n`)); // keeps inactivity fresh
      vi.advanceTimersByTime(600);
      const err = await settled;
      expect(err).toBeInstanceOf(CodexCliError);
      expect((err as CodexCliError).subtype).toBe("error_hard_timeout");
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort wins over the guards, rejecting with AgentAbortError", async () => {
    const controller = new AbortController();
    const { child } = arm();
    const promise = new CodexCli("gpt-5-codex").agent("plan it", {
      signal: controller.signal,
      hardTimeoutMs: 60_000,
    });
    const settled = promise.catch((e) => e);
    child.stdout.emit("data", Buffer.from(`${threadLine}\n`));
    controller.abort();
    expect(await settled).toBeInstanceOf(AgentAbortError);
    expect(child.killed).toContain("SIGTERM");
  });

  it("an already-aborted signal never spawns codex (#159)", async () => {
    arm();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new CodexCli("gpt-5-codex").agent("plan it", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AgentAbortError);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("CodexCli.structured", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } } as Record<string, unknown>;

  it("inlines the schema on stdin and parses the reply", async () => {
    const { child, argv } = arm();
    const promise = new CodexCli("gpt-5-codex").structured("critique it", schema);
    child.stdout.emit("data", Buffer.from(`${threadLine}\n${messageLine('{"ok":true}')}\n`));
    child.emit("close", 0);
    const res = await promise;

    expect(child.stdin.written).toContain("critique it");
    expect(child.stdin.written).toContain(
      "Reply with ONLY a single JSON value matching this JSON Schema.",
    );
    expect(child.stdin.written).toContain(JSON.stringify(schema));
    expect(flagValue(argv(), "--sandbox")).toBe("read-only");
    expect(argv()).toContain("--ephemeral");
    expect(spawnOpts().cwd).toBe(tmpdir());
    expect(res).toEqual({ ok: true });
  });

  it("recovers JSON from a fenced reply", async () => {
    const { child } = arm();
    const promise = new CodexCli("gpt-5-codex").structured("critique it", schema);
    child.stdout.emit(
      "data",
      Buffer.from(`${messageLine('Here you go:\n```json\n{"ok":false}\n```')}\n`),
    );
    child.emit("close", 0);
    expect(await promise).toEqual({ ok: false });
  });

  it("rejects when the reply carries no JSON at all", async () => {
    const { child } = arm();
    const promise = new CodexCli("gpt-5-codex").structured("critique it", schema);
    child.stdout.emit("data", Buffer.from(`${messageLine("I could not comply.")}\n`));
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/No parseable JSON/);
  });

  // sessionId / tools / maxTurns exist for the claude runtime's structured call;
  // codex takes none of them and always runs ephemeral + read-only.
  it("ignores session, tools and turn options but honours cwd", async () => {
    const { child, argv } = arm();
    const promise = new CodexCli("gpt-5-codex").structured("critique it", schema, {
      cwd: "/wt/issue-1",
      sessionId: "33333333-3333-4333-8333-333333333333",
      tools: "Read,Grep,Glob",
      maxTurns: 8,
    });
    child.stdout.emit("data", Buffer.from(`${messageLine('{"ok":true}')}\n`));
    child.emit("close", 0);
    await promise;

    const joined = argv().join(" ");
    expect(joined).not.toContain("33333333-3333-4333-8333-333333333333");
    expect(joined).not.toContain("Read,Grep,Glob");
    expect(joined).not.toContain("--max-turns");
    expect(argv()).toContain("--ephemeral");
    expect(flagValue(argv(), "-C")).toBe("/wt/issue-1");
    expect(spawnOpts().cwd).toBe("/wt/issue-1");
  });

  it("throws a CodexCliError when the run failed before replying", async () => {
    const { child } = arm();
    const promise = new CodexCli("gpt-5-codex").structured("critique it", schema);
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "error", message: "boom" })}\n`));
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/Codex CLI error: boom/);
  });
});

describe("tomlValue", () => {
  it("encodes strings as TOML basic strings, escaping quotes and newlines", () => {
    expect(tomlValue("plain")).toBe('"plain"');
    expect(tomlValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlValue("line1\nline2")).toBe('"line1\\nline2"');
    expect(tomlValue("C:\\tools\\codex.exe")).toBe('"C:\\\\tools\\\\codex.exe"');
  });

  it("encodes numbers and booleans bare", () => {
    expect(tomlValue(0)).toBe("0");
    expect(tomlValue(2000)).toBe("2000");
    expect(tomlValue(true)).toBe("true");
    expect(tomlValue(false)).toBe("false");
  });

  it("encodes arrays and inline tables, nesting included", () => {
    expect(tomlValue(["a", "b"])).toBe('["a","b"]');
    expect(tomlValue({ ELECTRON_RUN_AS_NODE: "1" })).toBe('{ELECTRON_RUN_AS_NODE="1"}');
    expect(tomlValue({ a: { b: [1, "x"] } })).toBe('{a={b=[1,"x"]}}');
    expect(tomlValue({})).toBe("{}");
  });

  it("falls back to a quoted string for null and undefined", () => {
    expect(tomlValue(null)).toBe('"null"');
    expect(tomlValue(undefined)).toBe('"undefined"');
  });
});

describe("codexConfigArgs", () => {
  it("drops the user config and the repo AGENTS.md by default", () => {
    expect(codexConfigArgs()).toEqual([
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-c",
      "project_doc_max_bytes=0",
    ]);
  });

  it("adds the three memory server overrides in command/args/env order", () => {
    const args = codexConfigArgs({
      memory: { cliBundlePath: "/app/skipper.bundle.cjs", repo: { owner: "Cicababba", name: "Skipper" } },
    });
    expect(args.filter((a) => a.startsWith("mcp_servers."))).toEqual([
      `mcp_servers.skipper-memory.command=${JSON.stringify(process.execPath)}`,
      'mcp_servers.skipper-memory.args=["/app/skipper.bundle.cjs","memory","serve","--repo","cicababba/skipper"]',
      'mcp_servers.skipper-memory.env={ELECTRON_RUN_AS_NODE="1"}',
    ]);
  });

  it("carries the system prompt last, and nothing when there is none", () => {
    expect(buildSystemPromptArgs()).toEqual([]);
    expect(codexConfigArgs({ systemPrompt: "be terse" }).slice(-2)).toEqual([
      "-c",
      'developer_instructions="be terse"',
    ]);
  });
});

describe("resolveCodex", () => {
  const realPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    invalidateResolvedCodex();
  };

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    invalidateResolvedCodex();
  });

  it("spawns codex off the PATH everywhere but Windows, memoizing the result", () => {
    setPlatform("linux");
    const first = resolveCodex();
    expect(first).toEqual({ file: "codex", argsPrefix: [] });
    expect(resolveCodex()).toBe(first);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("prefers a native .exe from a known Windows install location", () => {
    setPlatform("win32");
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const native = join(home, ".local", "bin", "codex.exe");
    vi.mocked(existsSync).mockImplementation((p) => String(p) === native);
    expect(resolveCodex()).toEqual({ file: native, argsPrefix: [] });
  });

  it("runs the npm package entry under our own runtime when only a shim is on PATH", () => {
    setPlatform("win32");
    vi.mocked(execSync).mockReturnValue("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd\r\n" as never);
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith("codex.js"));
    const resolved = resolveCodex();
    expect(resolved.file).toBe(process.execPath);
    expect(resolved.argsPrefix[0]).toContain(join("@openai", "codex", "bin", "codex.js"));
    expect(resolved.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("falls back to the bare name when Windows turns up nothing", () => {
    setPlatform("win32");
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(resolveCodex()).toEqual({ file: "codex", argsPrefix: [] });
  });
});
