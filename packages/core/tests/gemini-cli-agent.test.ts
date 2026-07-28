import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodingEvent } from "@skipper/shared";
import {
  GeminiCli,
  GeminiCliError,
  buildGeminiPrompt,
  geminiBaseArgs,
  geminiSessionArgs,
  invalidateResolvedGemini,
  resolveGemini,
} from "../src/llm/gemini-cli";
import { AgentAbortError } from "../src/llm/provider";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ""),
}));

// Only existsSync is faked (the Windows resolution probes it) — mkdir/write/rm
// stay real so the project settings file is exercised end to end. Its
// backup-and-restore half needs a truthful existsSync and lives in
// gemini-run.test.ts instead.
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

const roots: string[] = [];
function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "skipper-gemini-agent-"));
  roots.push(dir);
  return dir;
}
const settingsPath = (cwd: string) => join(cwd, ".gemini", "settings.json");

// DOCS-ONLY FIXTURES (#243 D2): hand-built from the documented JsonStreamEvent
// union, not captured from a real gemini run.
const SESSION_ID = "7f3a1c2e-9b4d-4e6a-8f1b-2c3d4e5f6a7b";
const toolLine = JSON.stringify({
  type: "tool_use",
  tool_name: "search_file_content",
  parameters: { pattern: "TODO" },
});
const resultLine = JSON.stringify({
  type: "result",
  status: "success",
  stats: { input_tokens: 25237, output_tokens: 112 },
});
const messageLine = (text: string) =>
  JSON.stringify({ type: "message", role: "assistant", content: text });
const okStream = `${toolLine}\n${messageLine("planned")}\n${resultLine}\n`;

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(execSync).mockReset();
  vi.mocked(execSync).mockReturnValue("" as never);
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
  invalidateResolvedGemini();
});

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GeminiCli.agent", () => {
  it("runs on the default approval mode and sessionless, returning text and usage", async () => {
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it");
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;

    const args = argv();
    expect(flagValue(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--skip-trust");
    // Headless gemini auto-denies anything that would prompt, which turns the
    // default mode into the read-leaning restriction (#243 D9).
    expect(args).toContain("--approval-mode=default");
    expect(args).not.toContain("--approval-mode=yolo");
    expect(flagValue(args, "-m")).toBe("gemini-2.5-pro");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
    // No cwd, so no project settings file and nothing to allow.
    expect(args).not.toContain("--allowed-mcp-server-names");
    expect(spawnOpts().cwd).toBe(tmpdir());
    expect(child.stdin.written).toBe("plan it");
    expect(res).toEqual({ text: "planned", usage: { inputTokens: 25237, outputTokens: 112 } });
    expect(res.sessionId).toBeUndefined();
  });

  it("omits -m when the runtime was constructed without one", async () => {
    const { child, argv } = arm();
    const promise = new GeminiCli().agent("plan it");
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(argv()).not.toContain("-m");
  });

  it("forwards stream events to onEvent, chunk boundaries included", async () => {
    const events: CodingEvent[] = [];
    const { child } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", {
      onEvent: (e) => events.push(e),
    });
    child.stdout.emit("data", Buffer.from(okStream.slice(0, 40)));
    child.stdout.emit("data", Buffer.from(okStream.slice(40)));
    child.emit("close", 0);
    await promise;
    expect(events.map((e) => e.kind)).toEqual(["tool-use", "text"]);
    expect(events[0]).toMatchObject({ tool: "Grep", detail: "TODO" });
  });

  it("with sessionId passes --session-id and returns it", async () => {
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", { sessionId: SESSION_ID });
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;
    expect(flagValue(argv(), "--session-id")).toBe(SESSION_ID);
    expect(argv()).not.toContain("--resume");
    expect(res.sessionId).toBe(SESSION_ID);
  });

  it("resumes with --resume and pins the spawn cwd", async () => {
    const cwd = makeWorktree();
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("continue", {
      resumeSessionId: SESSION_ID,
      cwd,
    });
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const res = await promise;
    expect(flagValue(argv(), "--resume")).toBe(SESSION_ID);
    expect(argv()).not.toContain("--session-id");
    // Sessions are keyed by a hash of the cwd, so a resume must run from the
    // same directory that minted the session.
    expect(spawnOpts().cwd).toBe(cwd);
    expect(res.sessionId).toBe(SESSION_ID);
  });

  it("prefers the session id the init event reported over the requested one", async () => {
    const carried = "44444444-4444-4444-8444-444444444444";
    const { child } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("continue", {
      resumeSessionId: SESSION_ID,
    });
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "init", session_id: carried })}\n${okStream}`),
    );
    child.emit("close", 0);
    expect((await promise).sessionId).toBe(carried);
  });

  it("writes the settings file with the memory server and releases it after the run", async () => {
    const cwd = makeWorktree();
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", {
      cwd,
      systemPrompt: "be terse",
      memory: {
        cliBundlePath: "/app/skipper.bundle.cjs",
        repo: { owner: "Cicababba", name: "Skipper" },
      },
    });

    const written = JSON.parse(readFileSync(settingsPath(cwd), "utf-8"));
    expect(written.context).toEqual({ fileName: "SKIPPER_NO_CONTEXT.md" });
    expect(written.mcpServers["skipper-memory"]).toEqual({
      command: process.execPath,
      args: ["/app/skipper.bundle.cjs", "memory", "serve", "--repo", "cicababba/skipper"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      trust: true,
    });
    expect(flagValue(argv(), "--allowed-mcp-server-names")).toBe("skipper-memory");
    expect(child.stdin.written).toBe("<system>\nbe terse\n</system>\n\nplan it");

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(existsSync(settingsPath(cwd))).toBe(false);
  });

  it("declares memory and graphify together, allowing both names (#259)", async () => {
    const cwd = makeWorktree();
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", {
      cwd,
      memory: {
        cliBundlePath: "/app/skipper.bundle.cjs",
        repo: { owner: "Cicababba", name: "Skipper" },
      },
      graph: { mcpBinPath: "/tools/bin/graphify-mcp", graphPath: "/graphs/skipper/graph.json" },
    });

    const written = JSON.parse(readFileSync(settingsPath(cwd), "utf-8"));
    expect(Object.keys(written.mcpServers)).toEqual(["skipper-memory", "graphify"]);
    // trust: true or a headless run auto-denies every graph tool call.
    expect(written.mcpServers.graphify).toEqual({
      command: "/tools/bin/graphify-mcp",
      args: ["--graph", "/graphs/skipper/graph.json"],
      trust: true,
    });
    expect(flagValue(argv(), "--allowed-mcp-server-names")).toBe("skipper-memory,graphify");

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
  });

  it("declares graphify alone when the run has no memory server", async () => {
    const cwd = makeWorktree();
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", {
      cwd,
      graph: { mcpBinPath: "/tools/bin/graphify-mcp", graphPath: "/graphs/skipper/graph.json" },
    });

    const written = JSON.parse(readFileSync(settingsPath(cwd), "utf-8"));
    expect(Object.keys(written.mcpServers)).toEqual(["graphify"]);
    expect(flagValue(argv(), "--allowed-mcp-server-names")).toBe("graphify");

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
  });

  it("allows a name nothing matches when the run has no memory server", async () => {
    const cwd = makeWorktree();
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", { cwd });
    expect(JSON.parse(readFileSync(settingsPath(cwd), "utf-8")).mcpServers).toBeUndefined();
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(flagValue(argv(), "--allowed-mcp-server-names")).toBe("skipper-none");
  });

  it("throws a GeminiCliError when the stream reported a failure", async () => {
    const { child } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it");
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "error", severity: "error", message: "over budget" })}\n`),
    );
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/Gemini CLI error: over budget/);
  });

  it("explains how to install gemini when the binary is missing", async () => {
    const { child } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it");
    const err: NodeJS.ErrnoException = new Error("spawn gemini ENOENT");
    err.code = "ENOENT";
    child.emit("error", err);
    await expect(promise).rejects.toThrow(
      /Gemini CLI is not installed.*npm install -g @google\/gemini-cli.*pick a different runtime in Settings\./s,
    );
  });

  it("reports a turn-limit exit as the salvageable error_max_turns subtype", async () => {
    const { child } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it");
    const settled = promise.catch((e) => e);
    child.emit("close", 53);
    const err = await settled;
    expect(err).toBeInstanceOf(GeminiCliError);
    expect((err as GeminiCliError).subtype).toBe("error_max_turns");
  });
});

describe("GeminiCli.agent guards", () => {
  it("kills a silent run past inactivityTimeoutMs with subtype error_inactivity", async () => {
    vi.useFakeTimers();
    try {
      const { child } = arm();
      const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", {
        inactivityTimeoutMs: 1000,
        hardTimeoutMs: 60_000,
      });
      const settled = promise.catch((e) => e);
      child.stdout.emit("data", Buffer.from(`${messageLine("thinking")}\n`)); // arms, then silent
      vi.advanceTimersByTime(1001);
      const err = await settled;
      expect(err).toBeInstanceOf(GeminiCliError);
      expect((err as GeminiCliError).subtype).toBe("error_inactivity");
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a chatty run past hardTimeoutMs with subtype error_hard_timeout", async () => {
    vi.useFakeTimers();
    try {
      const { child } = arm();
      const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", {
        inactivityTimeoutMs: 60_000,
        hardTimeoutMs: 2000,
      });
      const settled = promise.catch((e) => e);
      vi.advanceTimersByTime(1500);
      child.stdout.emit("data", Buffer.from(`${messageLine("still going")}\n`));
      vi.advanceTimersByTime(600);
      const err = await settled;
      expect(err).toBeInstanceOf(GeminiCliError);
      expect((err as GeminiCliError).subtype).toBe("error_hard_timeout");
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort wins over the guards, rejecting with AgentAbortError", async () => {
    const controller = new AbortController();
    const { child } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").agent("plan it", {
      signal: controller.signal,
      hardTimeoutMs: 60_000,
    });
    const settled = promise.catch((e) => e);
    child.stdout.emit("data", Buffer.from(`${messageLine("working")}\n`));
    controller.abort();
    expect(await settled).toBeInstanceOf(AgentAbortError);
    expect(child.killed).toContain("SIGTERM");
  });

  it("an already-aborted signal never spawns gemini, and still releases the settings file (#159)", async () => {
    const cwd = makeWorktree();
    arm();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new GeminiCli("gemini-2.5-pro").agent("plan it", { cwd, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AgentAbortError);
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(settingsPath(cwd))).toBe(false);
  });
});

describe("GeminiCli.structured", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } } as Record<string, unknown>;

  it("runs read-leaning, inlines the schema on stdin, and parses the reply", async () => {
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").structured("critique it", schema);
    child.stdout.emit("data", Buffer.from(`${messageLine('{"ok":true}')}\n`));
    child.emit("close", 0);
    const res = await promise;

    expect(argv()).toContain("--approval-mode=default");
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
    const promise = new GeminiCli("gemini-2.5-pro").structured("critique it", schema);
    child.stdout.emit(
      "data",
      Buffer.from(`${messageLine('Here you go:\n```json\n{"ok":false}\n```')}\n`),
    );
    child.emit("close", 0);
    expect(await promise).toEqual({ ok: false });
  });

  it("rejects when the reply carries no JSON at all", async () => {
    const { child } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").structured("critique it", schema);
    child.stdout.emit("data", Buffer.from(`${messageLine("I could not comply.")}\n`));
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/No parseable JSON/);
  });

  // sessionId / tools / maxTurns exist for the claude runtime's structured call;
  // gemini takes none of them and always runs sessionless.
  it("ignores session, tools and turn options but honours cwd", async () => {
    const cwd = makeWorktree();
    const { child, argv } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").structured("critique it", schema, {
      cwd,
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
    expect(spawnOpts().cwd).toBe(cwd);
    // The settings file is written for the GEMINI.md suppression alone here, so
    // a structured call is isolated from the user's own MCP servers too.
    expect(flagValue(argv(), "--allowed-mcp-server-names")).toBe("skipper-none");
    expect(existsSync(settingsPath(cwd))).toBe(false);
  });

  it("throws a GeminiCliError when the run failed before replying", async () => {
    const { child } = arm();
    const promise = new GeminiCli("gemini-2.5-pro").structured("critique it", schema);
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "error", severity: "error", message: "boom" })}\n`),
    );
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/Gemini CLI error: boom/);
  });
});

describe("gemini argv helpers", () => {
  it("shares the stream-json and trust flags on every run", () => {
    expect(geminiBaseArgs()).toEqual(["--output-format", "stream-json", "--skip-trust"]);
  });

  it("prefixes the system prompt only when there is one", () => {
    expect(buildGeminiPrompt(undefined, "do it")).toBe("do it");
    expect(buildGeminiPrompt("be terse", "do it")).toBe("<system>\nbe terse\n</system>\n\ndo it");
  });

  it("never emits --resume and --session-id together (#243 D10)", () => {
    expect(geminiSessionArgs()).toEqual([]);
    expect(geminiSessionArgs("mint-me")).toEqual(["--session-id", "mint-me"]);
    expect(geminiSessionArgs(undefined, "resume-me")).toEqual(["--resume", "resume-me"]);
    expect(geminiSessionArgs("mint-me", "resume-me")).toEqual(["--resume", "resume-me"]);
  });
});

describe("resolveGemini", () => {
  const realPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    invalidateResolvedGemini();
  };

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    invalidateResolvedGemini();
  });

  it("spawns gemini off the PATH everywhere but Windows, memoizing the result", () => {
    setPlatform("linux");
    const first = resolveGemini();
    expect(first).toEqual({ file: "gemini", argsPrefix: [] });
    expect(resolveGemini()).toBe(first);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("prefers a native .exe from a known Windows install location", () => {
    setPlatform("win32");
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const native = join(home, ".local", "bin", "gemini.exe");
    vi.mocked(existsSync).mockImplementation((p) => String(p) === native);
    expect(resolveGemini()).toEqual({ file: native, argsPrefix: [] });
  });

  // The package's real Windows bin layout is unverified (#243), so both plausible
  // entries are probed before giving up on the node-under-Electron shim.
  it("runs the npm package entry under our own runtime when only a shim is on PATH", () => {
    setPlatform("win32");
    vi.mocked(execSync).mockReturnValue("C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd\r\n" as never);
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith(join("dist", "index.js")));
    const resolved = resolveGemini();
    expect(resolved.file).toBe(process.execPath);
    expect(resolved.argsPrefix[0]).toContain(join("@google", "gemini-cli", "dist", "index.js"));
    expect(resolved.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("falls back to the package's bundle entry when there is no dist/index.js", () => {
    setPlatform("win32");
    vi.mocked(execSync).mockReturnValue("C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd\r\n" as never);
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith(join("bundle", "gemini.js")));
    const resolved = resolveGemini();
    expect(resolved.file).toBe(process.execPath);
    expect(resolved.argsPrefix[0]).toContain(join("@google", "gemini-cli", "bundle", "gemini.js"));
  });

  it("falls back to the bare name when Windows turns up nothing", () => {
    setPlatform("win32");
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(resolveGemini()).toEqual({ file: "gemini", argsPrefix: [] });
  });
});
