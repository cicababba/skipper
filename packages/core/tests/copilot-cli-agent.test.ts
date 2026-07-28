import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CodingEvent } from "@skipper/shared";
import {
  CopilotCli,
  CopilotCliError,
  buildCopilotMcpConfig,
  buildCopilotPrompt,
  buildReadLeaningArgs,
  copilotBaseArgs,
  invalidateResolvedCopilot,
  resolveCopilot,
} from "../src/llm/copilot-cli";
import { AgentAbortError } from "../src/llm/provider";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ""),
}));

// Only existsSync is faked (the Windows resolution probes it) — mkdtemp/write/rm
// stay real so the temp MCP config is exercised end to end.
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
const flagValues = (a: string[], flag: string) =>
  a.reduce<string[]>((acc, v, i) => (v === flag ? [...acc, a[i + 1]] : acc), []);

// BEST-EFFORT FIXTURES (#242): undocumented JSONL schema, community event names.
const SESSION_ID = "7f3a1c2e-9b4d-4e6a-8f1b-2c3d4e5f6a7b";
const toolLine = JSON.stringify({
  type: "tool.execution_start",
  tool_name: "shell",
  arguments: { command: "rg TODO" },
});
const turnLine = JSON.stringify({
  type: "assistant.turn_end",
  usage: { input_tokens: 25237, output_tokens: 112 },
});
const messageLine = (text: string) => JSON.stringify({ type: "assistant.message", text });
const okStream = `${toolLine}\n${messageLine("planned")}\n${turnLine}\n`;

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(execSync).mockReset();
  vi.mocked(execSync).mockReturnValue("" as never);
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
  invalidateResolvedCopilot();
});

describe("CopilotCli.agent", () => {
  it("runs write-denied and sessionless, returning the last message and usage", async () => {
    const { child, argv } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it");
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;

    const args = argv();
    expect(flagValue(args, "--output-format")).toBe("json");
    expect(args).toContain("--no-ask-user");
    expect(args).toContain("--no-custom-instructions");
    expect(flagValue(args, "--model")).toBe("claude-sonnet-4.5");
    expect(flagValues(args, "--deny-tool")).toEqual(["write"]);
    expect(args).not.toContain("-C");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
    expect(spawnOpts().cwd).toBe(tmpdir());
    expect(child.stdin.written).toBe("plan it");
    expect(res).toEqual({ text: "planned", usage: { inputTokens: 25237, outputTokens: 112 } });
    expect(res.sessionId).toBeUndefined();
  });

  it("omits --model when the runtime was constructed without one", async () => {
    const { child, argv } = arm();
    const promise = new CopilotCli().agent("plan it");
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(argv()).not.toContain("--model");
  });

  it("forwards stream events to onEvent, chunk boundaries included", async () => {
    const events: CodingEvent[] = [];
    const { child } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it", {
      onEvent: (e) => events.push(e),
    });
    child.stdout.emit("data", Buffer.from(okStream.slice(0, 40)));
    child.stdout.emit("data", Buffer.from(okStream.slice(40)));
    child.emit("close", 0);
    await promise;
    // No agent-init without a session id: there is none to announce.
    expect(events.map((e) => e.kind)).toEqual(["tool-use", "text"]);
  });

  it("with sessionId passes --session-id, announces it, and returns it", async () => {
    const events: CodingEvent[] = [];
    const { child, argv } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it", {
      sessionId: SESSION_ID,
      onEvent: (e) => events.push(e),
    });
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;
    expect(flagValue(argv(), "--session-id")).toBe(SESSION_ID);
    expect(events[0]).toEqual({ kind: "agent-init", sessionId: SESSION_ID });
    expect(res.sessionId).toBe(SESSION_ID);
  });

  it("resumes with --resume and pins cwd with -C", async () => {
    const { child, argv } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("continue", {
      resumeSessionId: SESSION_ID,
      cwd: "/wt/issue-1",
    });
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;
    expect(flagValue(argv(), "--resume")).toBe(SESSION_ID);
    expect(argv()).not.toContain("--session-id");
    expect(flagValue(argv(), "-C")).toBe("/wt/issue-1");
    expect(spawnOpts().cwd).toBe("/wt/issue-1");
    expect(res.sessionId).toBe(SESSION_ID);
  });

  it("prefers a session id the stream carried over the requested one", async () => {
    const carried = "44444444-4444-4444-8444-444444444444";
    const { child } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("continue", {
      resumeSessionId: SESSION_ID,
    });
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "assistant.turn_start", session_id: carried })}\n${okStream}`),
    );
    child.emit("close", 0);
    expect((await promise).sessionId).toBe(carried);
  });

  it("prefixes the system prompt and attaches the memory MCP config file", async () => {
    const { child, argv } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it", {
      systemPrompt: "be terse",
      memory: {
        cliBundlePath: "/app/skipper.bundle.cjs",
        repo: { owner: "Cicababba", name: "Skipper" },
      },
    });
    const configPath = flagValue(argv(), "--additional-mcp-config");
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers["skipper-memory"]).toMatchObject({
      type: "local",
      command: process.execPath,
      args: ["/app/skipper.bundle.cjs", "memory", "serve", "--repo", "cicababba/skipper"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(child.stdin.written).toBe("<system>\nbe terse\n</system>\n\nplan it");

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("attaches a graphify-only MCP config file and releases it after the run (#259)", async () => {
    const { child, argv } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it", {
      graph: { mcpBinPath: "/tools/bin/graphify-mcp", graphPath: "/graphs/skipper/graph.json" },
    });
    const configPath = flagValue(argv(), "--additional-mcp-config");
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(Object.keys(written.mcpServers)).toEqual(["graphify"]);
    expect(written.mcpServers.graphify).toEqual({
      type: "local",
      command: "/tools/bin/graphify-mcp",
      args: ["--graph", "/graphs/skipper/graph.json"],
      tools: ["*"],
    });

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("writes no MCP config file when neither memory nor graph is set", async () => {
    const { child, argv } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it");
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(argv()).not.toContain("--additional-mcp-config");
  });

  it("throws a CopilotCliError when the stream reported a failure", async () => {
    const { child } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it");
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "error", message: "over budget" })}\n`),
    );
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/Copilot CLI error: over budget/);
  });

  it("explains how to install copilot when the binary is missing", async () => {
    const { child } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it");
    const err: NodeJS.ErrnoException = new Error("spawn copilot ENOENT");
    err.code = "ENOENT";
    child.emit("error", err);
    await expect(promise).rejects.toThrow(
      /Copilot CLI is not installed.*npm install -g @github\/copilot.*pick a different runtime in Settings\./s,
    );
  });
});

describe("CopilotCli.agent guards", () => {
  it("kills a silent run past inactivityTimeoutMs with subtype error_inactivity", async () => {
    vi.useFakeTimers();
    try {
      const { child } = arm();
      const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it", {
        inactivityTimeoutMs: 1000,
        hardTimeoutMs: 60_000,
      });
      const settled = promise.catch((e) => e);
      child.stdout.emit("data", Buffer.from(`${messageLine("thinking")}\n`)); // arms, then silent
      vi.advanceTimersByTime(1001);
      const err = await settled;
      expect(err).toBeInstanceOf(CopilotCliError);
      expect((err as CopilotCliError).subtype).toBe("error_inactivity");
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a chatty run past hardTimeoutMs with subtype error_hard_timeout", async () => {
    vi.useFakeTimers();
    try {
      const { child } = arm();
      const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it", {
        inactivityTimeoutMs: 60_000,
        hardTimeoutMs: 2000,
      });
      const settled = promise.catch((e) => e);
      vi.advanceTimersByTime(1500);
      child.stdout.emit("data", Buffer.from(`${messageLine("still going")}\n`));
      vi.advanceTimersByTime(600);
      const err = await settled;
      expect(err).toBeInstanceOf(CopilotCliError);
      expect((err as CopilotCliError).subtype).toBe("error_hard_timeout");
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort wins over the guards, rejecting with AgentAbortError", async () => {
    const controller = new AbortController();
    const { child } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").agent("plan it", {
      signal: controller.signal,
      hardTimeoutMs: 60_000,
    });
    const settled = promise.catch((e) => e);
    child.stdout.emit("data", Buffer.from(`${messageLine("working")}\n`));
    controller.abort();
    expect(await settled).toBeInstanceOf(AgentAbortError);
    expect(child.killed).toContain("SIGTERM");
  });

  it("an already-aborted signal never spawns copilot (#159)", async () => {
    arm();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new CopilotCli("claude-sonnet-4.5").agent("plan it", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AgentAbortError);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("CopilotCli.structured", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } } as Record<string, unknown>;

  it("denies write and shell, inlines the schema on stdin, and parses the reply", async () => {
    const { child, argv } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").structured("critique it", schema);
    child.stdout.emit("data", Buffer.from(`${messageLine('{"ok":true}')}\n`));
    child.emit("close", 0);
    const res = await promise;

    expect(flagValues(argv(), "--deny-tool")).toEqual(["write", "shell"]);
    expect(child.stdin.written).toContain("critique it");
    expect(child.stdin.written).toContain(
      "Reply with ONLY a single JSON value matching this JSON Schema. No prose, no code fences, no preamble.",
    );
    expect(child.stdin.written).toContain(JSON.stringify(schema));
    expect(spawnOpts().cwd).toBe(tmpdir());
    expect(res).toEqual({ ok: true });
  });

  it("recovers JSON from a fenced reply", async () => {
    const { child } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").structured("critique it", schema);
    child.stdout.emit(
      "data",
      Buffer.from(`${messageLine('Here you go:\n```json\n{"ok":false}\n```')}\n`),
    );
    child.emit("close", 0);
    expect(await promise).toEqual({ ok: false });
  });

  it("rejects when the reply carries no JSON at all", async () => {
    const { child } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").structured("critique it", schema);
    child.stdout.emit("data", Buffer.from(`${messageLine("I could not comply.")}\n`));
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/No parseable JSON/);
  });

  // sessionId / tools / maxTurns exist for the claude runtime's structured call;
  // copilot takes none of them and always runs sessionless.
  it("ignores session, tools and turn options but honours cwd", async () => {
    const { child, argv } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").structured("critique it", schema, {
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
    expect(argv()).not.toContain("--session-id");
    expect(flagValue(argv(), "-C")).toBe("/wt/issue-1");
    expect(spawnOpts().cwd).toBe("/wt/issue-1");
  });

  it("throws a CopilotCliError when the run failed before replying", async () => {
    const { child } = arm();
    const promise = new CopilotCli("claude-sonnet-4.5").structured("critique it", schema);
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "error", message: "boom" })}\n`));
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/Copilot CLI error: boom/);
  });
});

describe("copilot argv helpers", () => {
  it("shares the JSON/headless/no-instructions flags on every run", () => {
    expect(copilotBaseArgs()).toEqual([
      "--output-format",
      "json",
      "--no-ask-user",
      "--no-custom-instructions",
    ]);
  });

  it("denies write for agent and write+shell for structured", () => {
    expect(buildReadLeaningArgs("agent")).toEqual(["--deny-tool", "write"]);
    expect(buildReadLeaningArgs("structured")).toEqual([
      "--deny-tool",
      "write",
      "--deny-tool",
      "shell",
    ]);
  });

  it("prefixes the system prompt only when there is one", () => {
    expect(buildCopilotPrompt(undefined, "do it")).toBe("do it");
    expect(buildCopilotPrompt("be terse", "do it")).toBe("<system>\nbe terse\n</system>\n\ndo it");
  });
});

describe("buildCopilotMcpConfig", () => {
  const memory = {
    cliBundlePath: "/app/skipper.bundle.cjs",
    repo: { owner: "Cicababba", name: "Skipper" },
  };
  const graph = { mcpBinPath: "/tools/bin/graphify-mcp", graphPath: "/graphs/skipper/graph.json" };

  it("writes a one-server config file and releases it on cleanup", () => {
    const { args, cleanup } = buildCopilotMcpConfig(memory);
    expect(args[0]).toBe("--additional-mcp-config");
    const file = args[1];
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      mcpServers: {
        "skipper-memory": {
          type: "local",
          command: process.execPath,
          args: ["/app/skipper.bundle.cjs", "memory", "serve", "--repo", "cicababba/skipper"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          tools: ["*"],
        },
      },
    });
    cleanup();
    expect(existsSync(dirname(file))).toBe(false);
  });

  it("writes both servers, each with the full tool allowance, when memory and graph are set", () => {
    const { args, cleanup } = buildCopilotMcpConfig(memory, graph);
    expect(JSON.parse(readFileSync(args[1], "utf-8"))).toEqual({
      mcpServers: {
        "skipper-memory": {
          type: "local",
          command: process.execPath,
          args: ["/app/skipper.bundle.cjs", "memory", "serve", "--repo", "cicababba/skipper"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          tools: ["*"],
        },
        graphify: {
          type: "local",
          command: "/tools/bin/graphify-mcp",
          args: ["--graph", "/graphs/skipper/graph.json"],
          tools: ["*"],
        },
      },
    });
    cleanup();
  });

  it("writes the graphify server alone when there is no memory server", () => {
    const { args, cleanup } = buildCopilotMcpConfig(undefined, graph);
    expect(JSON.parse(readFileSync(args[1], "utf-8"))).toEqual({
      mcpServers: {
        graphify: {
          type: "local",
          command: "/tools/bin/graphify-mcp",
          args: ["--graph", "/graphs/skipper/graph.json"],
          tools: ["*"],
        },
      },
    });
    cleanup();
  });

  it("a second cleanup is a no-op, not a throw", () => {
    const { args, cleanup } = buildCopilotMcpConfig(memory);
    cleanup();
    cleanup();
    expect(existsSync(dirname(args[1]))).toBe(false);
  });
});

describe("resolveCopilot", () => {
  const realPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    invalidateResolvedCopilot();
  };

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    invalidateResolvedCopilot();
  });

  it("spawns copilot off the PATH everywhere but Windows, memoizing the result", () => {
    setPlatform("linux");
    const first = resolveCopilot();
    expect(first).toEqual({ file: "copilot", argsPrefix: [] });
    expect(resolveCopilot()).toBe(first);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("prefers a native .exe from a known Windows install location", () => {
    setPlatform("win32");
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const native = join(home, ".local", "bin", "copilot.exe");
    vi.mocked(existsSync).mockImplementation((p) => String(p) === native);
    expect(resolveCopilot()).toEqual({ file: native, argsPrefix: [] });
  });

  // R4 (#242): the package's real bin layout is unverified, so both plausible
  // entries are probed before giving up on the node-under-Electron shim.
  it("runs the npm package entry under our own runtime when only a shim is on PATH", () => {
    setPlatform("win32");
    vi.mocked(execSync).mockReturnValue("C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd\r\n" as never);
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith(join("copilot", "index.js")));
    const resolved = resolveCopilot();
    expect(resolved.file).toBe(process.execPath);
    expect(resolved.argsPrefix[0]).toContain(join("@github", "copilot", "index.js"));
    expect(resolved.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("falls back to the package's bin/copilot.js when there is no index.js", () => {
    setPlatform("win32");
    vi.mocked(execSync).mockReturnValue("C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd\r\n" as never);
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith(join("bin", "copilot.js")));
    const resolved = resolveCopilot();
    expect(resolved.file).toBe(process.execPath);
    expect(resolved.argsPrefix[0]).toContain(join("@github", "copilot", "bin", "copilot.js"));
  });

  it("falls back to the bare name when Windows turns up nothing", () => {
    setPlatform("win32");
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(resolveCopilot()).toEqual({ file: "copilot", argsPrefix: [] });
  });
});
