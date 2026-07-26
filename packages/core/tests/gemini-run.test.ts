import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { spawn } from "node:child_process";
import type { CodingEvent } from "@skipper/shared";
import { CodingAbortError, CodingTimeoutError } from "../src/coder/run";
import { runGeminiCodingAgent } from "../src/coder/gemini-run";
import { invalidateResolvedGemini } from "../src/llm/gemini-cli";

// Real argv builders and a real project settings file (written into a real temp
// worktree and really cleaned up), mocked invalidation — the ENOENT path is
// asserted through the spy, not by re-resolving gemini on the test machine.
vi.mock("../src/llm/gemini-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/gemini-cli")>();
  return { ...actual, invalidateResolvedGemini: vi.fn() };
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

function fakeSpawn(): {
  child: FakeChild;
  spawnImpl: typeof spawn;
  calls: { file: string; args: string[]; opts: Record<string, unknown> }[];
} {
  const child = new FakeChild();
  const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const spawnImpl = ((file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts });
    return child;
  }) as unknown as typeof spawn;
  return { child, spawnImpl, calls };
}

// DOCS-ONLY FIXTURES (#243 D2): the stream-json lines are hand-built from the
// documented JsonStreamEvent union, not captured from a real gemini run.
const SESSION_ID = "7f3a1c2e-9b4d-4e6a-8f1b-2c3d4e5f6a7b";
const messageLine = JSON.stringify({ type: "message", role: "assistant", content: "done" });
const resultLine = JSON.stringify({
  type: "result",
  status: "success",
  stats: { input_tokens: 1200, output_tokens: 80 },
});
const okStream = `${messageLine}\n${resultLine}\n`;

const roots: string[] = [];
function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "skipper-gemini-run-"));
  roots.push(dir);
  return dir;
}

function baseOpts(cwd: string, onEvent: (e: CodingEvent) => void = () => {}) {
  return {
    prompt: "implement it",
    cwd,
    model: "claude-sonnet-4.5",
    sessionId: SESSION_ID,
    onEvent,
  };
}

const flagValue = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
const settingsPath = (cwd: string) => join(cwd, ".gemini", "settings.json");

beforeEach(() => {
  vi.mocked(invalidateResolvedGemini).mockClear();
});

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runGeminiCodingAgent argv", () => {
  it("builds a fresh yolo run under the pre-minted session id, prompt on stdin", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;

    const { file, args, opts } = calls[0];
    expect(file).toBe("gemini");
    expect(flagValue(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--skip-trust");
    // Headless gemini auto-denies any tool that would prompt, so without yolo the
    // coder could not write a single file (#243 D9).
    expect(args).toContain("--approval-mode=yolo");
    expect(args).not.toContain("--approval-mode=default");
    expect(flagValue(args, "-m")).toBe("claude-sonnet-4.5");
    expect(flagValue(args, "--session-id")).toBe(SESSION_ID);
    expect(args).not.toContain("--resume");
    // No -C equivalent: gemini takes its project scope from the process cwd.
    expect(opts.cwd).toBe(cwd);
    expect(child.stdin.written).toBe("implement it");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  // #240: the runtime is constructed without a model when the role's Claude alias
  // would otherwise leak here — gemini then runs on its own configured default.
  it("omits -m entirely when the caller set none", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runGeminiCodingAgent({ ...baseOpts(cwd), model: undefined }, spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(calls[0].args).not.toContain("-m");
  });

  it("re-enters with --resume and drops --session-id", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runGeminiCodingAgent(
      { ...baseOpts(cwd), sessionId: undefined, resumeSessionId: SESSION_ID },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(flagValue(calls[0].args, "--resume")).toBe(SESSION_ID);
    expect(calls[0].args).not.toContain("--session-id");
  });

  // --session-id premints a NEW session and is mutually exclusive with --resume;
  // passing both would make gemini reject the invocation outright.
  it("prefers resume over a pre-minted id when both are set", async () => {
    const cwd = makeWorktree();
    const resumeId = "33333333-3333-4333-8333-333333333333";
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runGeminiCodingAgent({ ...baseOpts(cwd), resumeSessionId: resumeId }, spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(flagValue(calls[0].args, "--resume")).toBe(resumeId);
    expect(calls[0].args).not.toContain("--session-id");
  });

  it("prefixes the system prompt onto the stdin prompt (#243 D6)", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent({ ...baseOpts(cwd), systemPrompt: "be terse" }, spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(child.stdin.written).toBe("<system>\nbe terse\n</system>\n\nimplement it");
  });

  // Both options belong to the claude runtime: gemini has no per-run turn budget
  // and no path-scoping to hand the confinement rules to (#243 D4, D7).
  it("ignores confinement, maxTurns and graph entirely", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const cwd = makeWorktree();
      const { child, spawnImpl, calls } = fakeSpawn();
      const promise = runGeminiCodingAgent({ ...baseOpts(cwd), ...extra }, spawnImpl);
      child.stdout.emit("data", Buffer.from(okStream));
      child.emit("close", 0);
      await promise;
      return calls[0].args;
    };
    const plain = await run({});
    const decorated = await run({
      maxTurns: 300,
      graph: { repoRoot: "/repo", graphPath: "/graphs/repo.json" },
      confinement: {
        runRoot: "/tmp/wt",
        denyRoots: ["/home/me/repo"],
        cliBundlePath: "/app/skipper.bundle.cjs",
      },
    });
    expect(decorated).toEqual(plain);
    expect(decorated.join(" ")).not.toContain("300");
    expect(decorated.join(" ")).not.toContain("graph");
  });
});

describe("runGeminiCodingAgent project settings file (#243 D5)", () => {
  const memory = {
    cliBundlePath: "/app/skipper.bundle.cjs",
    repo: { owner: "Cicababba", name: "Skipper" },
  };

  it("writes the memory server with trust and allows only it", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runGeminiCodingAgent({ ...baseOpts(cwd), memory }, spawnImpl);

    // The file only exists while the run does — read it before letting it close.
    const written = JSON.parse(readFileSync(settingsPath(cwd), "utf-8"));
    expect(written).toEqual({
      // No flag suppresses GEMINI.md; a context file name no repo has does.
      context: { fileName: "SKIPPER_NO_CONTEXT.md" },
      mcpServers: {
        "skipper-memory": {
          command: process.execPath,
          args: ["/app/skipper.bundle.cjs", "memory", "serve", "--repo", "cicababba/skipper"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          // Headless gemini denies every tool confirmation, so an untrusted
          // server's tools would all come back denied.
          trust: true,
        },
      },
    });
    expect(flagValue(calls[0].args, "--allowed-mcp-server-names")).toBe("skipper-memory");

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(existsSync(settingsPath(cwd))).toBe(false);
    expect(existsSync(join(cwd, ".gemini"))).toBe(false);
  });

  it("still writes the file without memory, allowing a server name nothing matches", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);

    const written = JSON.parse(readFileSync(settingsPath(cwd), "utf-8"));
    expect(written).toEqual({ context: { fileName: "SKIPPER_NO_CONTEXT.md" } });
    // Isolation from the user's own configured servers: none of them match.
    expect(flagValue(calls[0].args, "--allowed-mcp-server-names")).toBe("skipper-none");

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(existsSync(settingsPath(cwd))).toBe(false);
  });

  it("backs up a settings file the repo already tracks and restores it byte for byte", async () => {
    const cwd = makeWorktree();
    const original = JSON.stringify({ theme: "GitHub", mcpServers: { mine: { command: "x" } } }, null, 2);
    mkdirSync(join(cwd, ".gemini"), { recursive: true });
    writeFileSync(settingsPath(cwd), original);

    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    expect(JSON.parse(readFileSync(settingsPath(cwd), "utf-8")).theme).toBeUndefined();

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(readFileSync(settingsPath(cwd), "utf-8")).toBe(original);
    // The dir was the repo's, not ours — it stays.
    expect(existsSync(join(cwd, ".gemini"))).toBe(true);
  });

  it("leaves a pre-existing .gemini dir standing while removing only our file", async () => {
    const cwd = makeWorktree();
    mkdirSync(join(cwd, ".gemini"), { recursive: true });
    writeFileSync(join(cwd, ".gemini", "commands.toml"), "# theirs");

    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(existsSync(settingsPath(cwd))).toBe(false);
    expect(readFileSync(join(cwd, ".gemini", "commands.toml"), "utf-8")).toBe("# theirs");
  });

  it("releases the settings file when the run is killed instead of closing", async () => {
    const cwd = makeWorktree();
    const controller = new AbortController();
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(
      { ...baseOpts(cwd), memory, signal: controller.signal },
      spawnImpl,
    );
    expect(existsSync(settingsPath(cwd))).toBe(true);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(CodingAbortError);
    expect(existsSync(settingsPath(cwd))).toBe(false);
    expect(child.killed).toContain("SIGTERM");
  });

  it("releases the settings file when a guard timer kills the run", async () => {
    vi.useFakeTimers();
    try {
      const cwd = makeWorktree();
      const { child, spawnImpl } = fakeSpawn();
      const promise = runGeminiCodingAgent({ ...baseOpts(cwd), inactivityTimeoutMs: 1000 }, spawnImpl);
      const settled = promise.catch((e) => e);
      expect(existsSync(settingsPath(cwd))).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(await settled).toBeInstanceOf(CodingTimeoutError);
      expect(existsSync(settingsPath(cwd))).toBe(false);
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runGeminiCodingAgent git exclude (#243 D5)", () => {
  const excludeOf = (gitDir: string) => join(gitDir, "info", "exclude");

  const finish = async (cwd: string) => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
  };

  it("appends .gemini/ to a plain repo's info/exclude", async () => {
    const cwd = makeWorktree();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    writeFileSync(excludeOf(join(cwd, ".git")), "*.log\n");
    await finish(cwd);
    expect(readFileSync(excludeOf(join(cwd, ".git")), "utf-8")).toBe("*.log\n.gemini/\n");
  });

  it("creates the exclude file when the repo has none", async () => {
    const cwd = makeWorktree();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    await finish(cwd);
    expect(readFileSync(excludeOf(join(cwd, ".git")), "utf-8")).toBe(".gemini/\n");
  });

  it("terminates an unterminated last line before appending", async () => {
    const cwd = makeWorktree();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    writeFileSync(excludeOf(join(cwd, ".git")), "*.log");
    await finish(cwd);
    expect(readFileSync(excludeOf(join(cwd, ".git")), "utf-8")).toBe("*.log\n.gemini/\n");
  });

  it("never writes the entry twice", async () => {
    const cwd = makeWorktree();
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    await finish(cwd);
    await finish(cwd);
    expect(readFileSync(excludeOf(join(cwd, ".git")), "utf-8")).toBe(".gemini/\n");
  });

  // A worktree's .git is a file pointing at <repo>/.git/worktrees/<name>, whose
  // commondir points back at the repo's real git dir — that is where the
  // repo-wide exclude lives.
  it("follows a linked worktree's gitdir pointer to the common dir", async () => {
    const repo = makeWorktree();
    const cwd = makeWorktree();
    const worktreeGitDir = join(repo, ".git", "worktrees", "issue-243");
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    writeFileSync(join(cwd, ".git"), `gitdir: ${worktreeGitDir}\n`);

    await finish(cwd);
    expect(readFileSync(excludeOf(join(repo, ".git")), "utf-8")).toBe(".gemini/\n");
    expect(existsSync(excludeOf(worktreeGitDir))).toBe(false);
  });

  it("runs fine outside a repo, where there is no exclude to write", async () => {
    const cwd = makeWorktree();
    await finish(cwd);
    expect(existsSync(join(cwd, ".git"))).toBe(false);
  });
});

describe("runGeminiCodingAgent result", () => {
  it("emits exactly one terminal result event and resolves on it", async () => {
    const cwd = makeWorktree();
    const events: CodingEvent[] = [];
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd, (e) => events.push(e)), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${messageLine}\n`));
    child.stdout.emit("data", Buffer.from(`${resultLine}\n`));
    child.emit("close", 0);
    const result = await promise;

    expect(events.map((e) => e.kind)).toEqual(["text", "result"]);
    expect(events.filter((e) => e.kind === "result")).toHaveLength(1);
    expect(events[1]).toEqual({
      kind: "result",
      ok: true,
      summary: "done",
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
    expect(result).toEqual({
      ok: true,
      summary: "done",
      resultText: "done",
      sessionId: SESSION_ID,
    });
  });

  it("announces the session id from the init event and returns it", async () => {
    const cwd = makeWorktree();
    const carried = "44444444-4444-4444-8444-444444444444";
    const events: CodingEvent[] = [];
    const initLine = JSON.stringify({ type: "init", session_id: carried, model: "gemini-2.5-pro" });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd, (e) => events.push(e)), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${initLine}\n${okStream}`));
    child.emit("close", 0);
    const result = await promise;
    expect(events[0]).toEqual({ kind: "agent-init", sessionId: carried, model: "gemini-2.5-pro" });
    expect(result.sessionId).toBe(carried);
  });

  it("round-trips the pre-minted session id when the stream carries none", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    expect((await promise).sessionId).toBe(SESSION_ID);
  });

  it("falls back to the resumed id when neither stream nor pre-mint provided one", async () => {
    const cwd = makeWorktree();
    const resumeId = "55555555-5555-4555-8555-555555555555";
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(
      { ...baseOpts(cwd), sessionId: undefined, resumeSessionId: resumeId },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${messageLine}\n`));
    child.emit("close", 0);
    expect((await promise).sessionId).toBe(resumeId);
  });

  it("keeps the full result text while the summary stays capped (#146)", async () => {
    const cwd = makeWorktree();
    const big = "x".repeat(3000);
    const bigLine = JSON.stringify({ type: "message", role: "assistant", content: big });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${bigLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(result.resultText).toBe(big);
    expect(result.summary.length).toBe(2000);
  });

  it("resolves a stream failure as a non-ok result instead of rejecting", async () => {
    const cwd = makeWorktree();
    const errorLine = JSON.stringify({ type: "error", severity: "error", message: "model refused" });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${errorLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("model refused");
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it("marks the result not-ok when gemini exits nonzero after streaming", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 1);
    expect((await promise).ok).toBe(false);
  });

  it("rejects with the stderr tail when gemini dies before emitting anything", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.stderr.emit("data", Buffer.from("unknown argument --skip-trust"));
    child.emit("close", 42);
    await expect(promise).rejects.toThrow(/exited with code 42.*unknown argument --skip-trust/s);
  });
});

describe("runGeminiCodingAgent guards", () => {
  it("abort kills the tree and rejects with CodingAbortError", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl } = fakeSpawn();
    const controller = new AbortController();
    const promise = runGeminiCodingAgent({ ...baseOpts(cwd), signal: controller.signal }, spawnImpl);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(CodingAbortError);
    expect(child.killed).toContain("SIGTERM");
  });

  it("escalates SIGTERM to SIGKILL after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const cwd = makeWorktree();
      const { child, spawnImpl } = fakeSpawn();
      const controller = new AbortController();
      const promise = runGeminiCodingAgent({ ...baseOpts(cwd), signal: controller.signal }, spawnImpl);
      const settled = promise.catch((e) => e);
      controller.abort();
      expect(child.killed).toEqual(["SIGTERM"]);
      vi.advanceTimersByTime(3001);
      expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
      expect(await settled).toBeInstanceOf(CodingAbortError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a silent run with CodingTimeoutError kind inactivity", async () => {
    vi.useFakeTimers();
    try {
      const cwd = makeWorktree();
      const { child, spawnImpl } = fakeSpawn();
      const promise = runGeminiCodingAgent({ ...baseOpts(cwd), inactivityTimeoutMs: 1000 }, spawnImpl);
      const settled = promise.catch((e) => e);
      vi.advanceTimersByTime(1001);
      const err = await settled;
      expect(err).toBeInstanceOf(CodingTimeoutError);
      expect((err as CodingTimeoutError).kind).toBe("inactivity");
      expect((err as CodingTimeoutError).limitMs).toBe(1000);
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a long-running but chatty run with kind hard_timeout", async () => {
    vi.useFakeTimers();
    try {
      const cwd = makeWorktree();
      const { child, spawnImpl } = fakeSpawn();
      const promise = runGeminiCodingAgent(
        { ...baseOpts(cwd), inactivityTimeoutMs: 60_000, hardTimeoutMs: 2000 },
        spawnImpl,
      );
      const settled = promise.catch((e) => e);
      vi.advanceTimersByTime(1500);
      child.stdout.emit("data", Buffer.from(`${messageLine}\n`)); // keeps inactivity fresh
      vi.advanceTimersByTime(600);
      const err = await settled;
      expect(err).toBeInstanceOf(CodingTimeoutError);
      expect((err as CodingTimeoutError).kind).toBe("hard_timeout");
      expect((err as CodingTimeoutError).limitMs).toBe(2000);
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates the memoized resolution when gemini is missing (ENOENT)", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    const err: NodeJS.ErrnoException = new Error("spawn gemini ENOENT");
    err.code = "ENOENT";
    child.emit("error", err);
    await expect(promise).rejects.toThrow(/ENOENT/);
    expect(invalidateResolvedGemini).toHaveBeenCalled();
    expect(existsSync(settingsPath(cwd))).toBe(false);
  });

  it("does not invalidate the resolution on an unrelated spawn error", async () => {
    const cwd = makeWorktree();
    const { child, spawnImpl } = fakeSpawn();
    const promise = runGeminiCodingAgent(baseOpts(cwd), spawnImpl);
    child.emit("error", new Error("EPIPE"));
    await expect(promise).rejects.toThrow(/EPIPE/);
    expect(invalidateResolvedGemini).not.toHaveBeenCalled();
  });
});
