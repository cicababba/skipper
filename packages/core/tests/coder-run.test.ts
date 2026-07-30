import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import type { CodingEvent } from "@skipper/shared";
import { runCodingAgent, CodingAbortError, CodingTimeoutError } from "../src/coder";

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

function fakeSpawn(): { child: FakeChild; spawnImpl: typeof spawn; calls: { file: string; args: string[]; opts: Record<string, unknown> }[] } {
  const child = new FakeChild();
  const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const spawnImpl = ((file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts });
    return child;
  }) as unknown as typeof spawn;
  return { child, spawnImpl, calls };
}

const initLine = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "11111111-1111-4111-8111-111111111111",
});
const okResultLine = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  num_turns: 3,
});

function baseOpts(onEvent: (e: CodingEvent) => void = () => {}) {
  return { prompt: "implement it", cwd: "/tmp/wt", model: "opus", onEvent };
}

// The write-rule shape is platform-dependent (#278), so every argv assertion over
// it pins the platform instead of inheriting the host's.
const hostPlatform = process.platform;
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("runCodingAgent", () => {
  afterEach(() => {
    stubPlatform(hostPlatform);
  });

  // #240: role models are Claude aliases, so a runtime running on something else
  // is built without one and the flag must disappear rather than ship "--model ".
  it("passes --model only when the caller set one", async () => {
    const argvFor = async (extra: Record<string, unknown>) => {
      const { child, spawnImpl, calls } = fakeSpawn();
      const promise = runCodingAgent({ ...baseOpts(), ...extra }, spawnImpl);
      child.stdout.emit("data", Buffer.from(`${initLine}\n${okResultLine}\n`));
      child.emit("close", 0);
      await promise;
      return calls[0].args;
    };
    expect((await argvFor({})).join(" ")).toContain("--model opus");
    const without = await argvFor({ model: undefined });
    expect(without).not.toContain("--model");
    expect(without).toContain("--max-turns");
  });

  it("builds write-capable streaming argv without session persistence opt-out", async () => {
    stubPlatform("linux");
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodingAgent(
      { ...baseOpts(), sessionId: "22222222-2222-4222-8222-222222222222", systemPrompt: "sys" },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${initLine}\n${okResultLine}\n`));
    child.emit("close", 0);
    await promise;

    const { args, opts } = calls[0];
    const joined = args.join(" ");
    expect(joined).toContain("--output-format stream-json");
    expect(args).toContain("--verbose");
    // --tools keeps the bare names; --allowedTools scopes the write tools to the
    // run root and drops the bare Edit/Write (#196, L1 confinement).
    expect(joined).toContain("--tools Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch");
    const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("Edit(//tmp/wt/**)");
    expect(allowed).toContain("Write(//tmp/wt/**)");
    expect(allowed).not.toContain("Edit");
    expect(allowed).not.toContain("Write");
    expect(joined).toContain("--session-id 22222222-2222-4222-8222-222222222222");
    expect(joined).toContain("--system-prompt sys");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    expect(opts.cwd).toBe("/tmp/wt");
    expect(child.stdin.written).toBe("implement it");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("adds the guard hook + confined env when confinement carries a CLI bundle (#196)", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodingAgent(
      {
        ...baseOpts(),
        sessionId: "22222222-2222-4222-8222-222222222222",
        confinement: {
          runRoot: "/tmp/wt",
          denyRoots: ["/home/me/repo"],
          cliBundlePath: "/app/skipper.bundle.cjs",
        },
      },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${initLine}\n${okResultLine}\n`));
    child.emit("close", 0);
    await promise;

    const { args, opts } = calls[0];
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.hooks.PreToolUse.map((h: { matcher: string }) => h.matcher)).toEqual([
      "Edit|Write",
      "Bash",
    ]);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("guard");
    expect((opts.env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("scopes writes but adds no guard hook when confinement has no CLI bundle (#196)", async () => {
    stubPlatform("linux");
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodingAgent(
      { ...baseOpts(), confinement: { runRoot: "/tmp/wt", denyRoots: ["/home/me/repo"] } },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${okResultLine}\n`));
    child.emit("close", 0);
    await promise;

    const { args } = calls[0];
    expect(args).not.toContain("--settings");
    const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("Write(//tmp/wt/**)");
  });

  // #278: no drive-letter rule shape matches on Windows (upstream
  // anthropics/claude-code#67849), so the write grant there is bare + guard-enforced.
  it("grants bare Edit/Write on win32 when the guard hook is active (#278)", async () => {
    stubPlatform("win32");
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodingAgent(
      {
        ...baseOpts(),
        cwd: "C:\\wt\\issue-1",
        confinement: {
          runRoot: "C:\\wt\\issue-1",
          denyRoots: ["C:\\repo"],
          protectRoots: ["C:\\Users\\me"],
          cliBundlePath: "C:\\app\\skipper.bundle.cjs",
        },
      },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${okResultLine}\n`));
    child.emit("close", 0);
    await promise;

    const { args } = calls[0];
    const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("Edit");
    expect(allowed).toContain("Write");
    expect(allowed.some((rule) => rule.startsWith("Edit("))).toBe(false);
    expect(args[args.indexOf("--settings") + 1]).toContain("--protect");
  });

  it("keeps the scoped drive-letter rules on win32 without a guard hook (#278)", async () => {
    stubPlatform("win32");
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodingAgent(
      {
        ...baseOpts(),
        cwd: "C:\\wt\\issue-1",
        confinement: { runRoot: "C:\\wt\\issue-1", denyRoots: ["C:\\repo"] },
      },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${okResultLine}\n`));
    child.emit("close", 0);
    await promise;

    const allowed = calls[0].args[calls[0].args.indexOf("--allowedTools") + 1].split(",");
    expect(allowed).toContain("Edit(//C:/wt/issue-1/**)");
    expect(allowed).toContain("Write(//C:/wt/issue-1/**)");
    expect(allowed).not.toContain("Edit");
    expect(allowed).not.toContain("Write");
  });

  it("uses --resume for re-entry", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodingAgent(
      { ...baseOpts(), resumeSessionId: "33333333-3333-4333-8333-333333333333" },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${okResultLine}\n`));
    child.emit("close", 0);
    await promise;
    const joined = calls[0].args.join(" ");
    expect(joined).toContain("--resume 33333333-3333-4333-8333-333333333333");
    expect(joined).not.toContain("--session-id");
  });

  it("forwards events and resolves with the result + init session id", async () => {
    const events: CodingEvent[] = [];
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodingAgent(baseOpts((e) => events.push(e)), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${initLine}\n`));
    child.stdout.emit("data", Buffer.from(`${okResultLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(events.map((e) => e.kind)).toEqual(["agent-init", "result"]);
    expect(result).toEqual({
      ok: true,
      summary: "done",
      resultText: "done",
      sessionId: "11111111-1111-4111-8111-111111111111",
      turns: 3,
      subtype: "success",
    });
  });

  it("captures the full result text while summary stays truncated (#146)", async () => {
    const big = "x".repeat(3000);
    const bigResultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: big,
      num_turns: 1,
    });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${initLine}\n${bigResultLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(result.resultText).toBe(big);
    expect(result.resultText!.length).toBe(3000);
    expect(result.summary.length).toBe(2000);
  });

  it("rejects on nonzero exit without a result", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodingAgent(baseOpts(), spawnImpl);
    child.stderr.emit("data", Buffer.from("boom"));
    child.emit("close", 1);
    await expect(promise).rejects.toThrow(/exited with code 1.*boom/s);
  });

  it("abort kills the child and rejects with CodingAbortError", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const controller = new AbortController();
    const promise = runCodingAgent({ ...baseOpts(), signal: controller.signal }, spawnImpl);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(CodingAbortError);
    expect(child.killed).toContain("SIGTERM");
  });

  it("kills a silent agent on inactivity timeout", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnImpl } = fakeSpawn();
      const promise = runCodingAgent({ ...baseOpts(), inactivityTimeoutMs: 1000 }, spawnImpl);
      const assertion = expect(promise).rejects.toThrow(/no output/);
      vi.advanceTimersByTime(1001);
      await assertion;
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a silent agent with CodingTimeoutError kind inactivity (#194)", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnImpl } = fakeSpawn();
      const promise = runCodingAgent({ ...baseOpts(), inactivityTimeoutMs: 1000 }, spawnImpl);
      const assertion = promise.catch((e) => e);
      vi.advanceTimersByTime(1001);
      const err = await assertion;
      expect(err).toBeInstanceOf(CodingTimeoutError);
      expect((err as CodingTimeoutError).kind).toBe("inactivity");
      expect((err as CodingTimeoutError).limitMs).toBe(1000);
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a run past the hard timeout even when streaming", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnImpl } = fakeSpawn();
      const promise = runCodingAgent(
        { ...baseOpts(), inactivityTimeoutMs: 60_000, hardTimeoutMs: 2000 },
        spawnImpl,
      );
      const assertion = expect(promise).rejects.toThrow(/hard time limit/);
      vi.advanceTimersByTime(1500);
      child.stdout.emit("data", Buffer.from(`${initLine}\n`)); // keeps inactivity fresh
      vi.advanceTimersByTime(600);
      await assertion;
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a hard-timeout kill with CodingTimeoutError kind hard_timeout (#194)", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnImpl } = fakeSpawn();
      const promise = runCodingAgent(
        { ...baseOpts(), inactivityTimeoutMs: 60_000, hardTimeoutMs: 2000 },
        spawnImpl,
      );
      const assertion = promise.catch((e) => e);
      vi.advanceTimersByTime(1500);
      child.stdout.emit("data", Buffer.from(`${initLine}\n`)); // keeps inactivity fresh
      vi.advanceTimersByTime(600);
      const err = await assertion;
      expect(err).toBeInstanceOf(CodingTimeoutError);
      expect((err as CodingTimeoutError).kind).toBe("hard_timeout");
      expect((err as CodingTimeoutError).limitMs).toBe(2000);
      expect(child.killed).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a max-turns death as a non-ok result carrying the subtype (#194)", async () => {
    const errorResultLine = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 300,
    });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${initLine}\n${errorResultLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.subtype).toBe("error_max_turns");
    expect(result.sessionId).toBe("11111111-1111-4111-8111-111111111111");
  });
});
