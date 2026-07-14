import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import type { CodingEvent } from "@skipper/shared";
import { runCodingAgent, CodingAbortError } from "../src/coder";

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

describe("runCodingAgent", () => {
  it("builds write-capable streaming argv without session persistence opt-out", async () => {
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
    expect(joined).toContain("--tools Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch");
    expect(joined).toContain("--allowedTools Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch");
    expect(joined).toContain("--session-id 22222222-2222-4222-8222-222222222222");
    expect(joined).toContain("--system-prompt sys");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    expect(opts.cwd).toBe("/tmp/wt");
    expect(child.stdin.written).toBe("implement it");
    expect(child.stdin.end).toHaveBeenCalled();
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
      sessionId: "11111111-1111-4111-8111-111111111111",
      turns: 3,
    });
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
});
