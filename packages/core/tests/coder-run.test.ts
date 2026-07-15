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

describe("runCodingAgent on codex-cli (#67)", () => {
  const codexLines = (...l: string[]) => l.join("\n") + "\n";
  const started = `{"type":"thread.started","thread_id":"019f-thread"}`;
  const done = `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}`;
  const message = (t: string) =>
    `{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":${JSON.stringify(t)}}}`;

  const codexOpts = (extra: Record<string, unknown> = {}) => ({
    ...baseOpts(),
    provider: "codex-cli" as const,
    model: "gpt-5.6-sol",
    ...extra,
  });

  it("lets the coder write, and takes its session id from the thread", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const p = runCodingAgent(codexOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(codexLines(started, message("shipped it"), done)));
    child.emit("close", 0);

    const res = await p;
    expect(res).toMatchObject({ ok: true, summary: "shipped it", sessionId: "019f-thread" });
    const args = calls[0].args;
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args[args.indexOf("-C") + 1]).toBe("/tmp/wt");
    // The persisted session is the shepherd's re-entry seam — never --ephemeral.
    expect(args).not.toContain("--ephemeral");
  });

  it("puts flags before `resume` — codex rejects them after it", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const p = runCodingAgent(codexOpts({ resumeSessionId: "019f-thread" }), spawnImpl);
    child.stdout.emit("data", Buffer.from(codexLines(started, done)));
    child.emit("close", 0);
    await p;

    const args = calls[0].args;
    const resumeAt = args.indexOf("resume");
    expect(args[resumeAt + 1]).toBe("019f-thread");
    expect(args.indexOf("--sandbox")).toBeLessThan(resumeAt);
    expect(args.indexOf("-C")).toBeLessThan(resumeAt);
    // The prompt still rides stdin, after the session id.
    expect(args.at(-1)).toBe("-");
    expect(child.stdin.written).toBe("implement it");
  });

  it("runs in its own process group so a kill reaches codex's shells", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const p = runCodingAgent(codexOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(codexLines(started, done)));
    child.emit("close", 0);
    await p;
    expect(calls[0].opts.detached).toBe(process.platform !== "win32");
    expect(calls[0].opts.windowsHide).toBe(true);
  });

  it("keeps the claude path on its own argv", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const p = runCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(initLine + "\n" + okResultLine + "\n"));
    child.emit("close", 0);
    await p;
    expect(calls[0].args).toContain("--max-turns");
    expect(calls[0].args).not.toContain("exec");
    expect(calls[0].opts.detached).toBe(false);
  });
});
