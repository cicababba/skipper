import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import type { CodingEvent } from "@skipper/shared";
import { CodingAbortError, CodingTimeoutError } from "../src/coder/run";
import { runCodexCodingAgent } from "../src/coder/codex-run";
import { invalidateResolvedCodex } from "../src/llm/codex-cli";

// Real argv builders, mocked invalidation — the ENOENT path is asserted through
// the spy, not by re-resolving codex on the test machine.
vi.mock("../src/llm/codex-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/codex-cli")>();
  return { ...actual, invalidateResolvedCodex: vi.fn() };
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

const THREAD_ID = "019f99b6-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const threadLine = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID });
const messageLine = JSON.stringify({
  type: "item.completed",
  item: { id: "item_0", type: "agent_message", text: "done" },
});
const turnLine = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 80 },
});
const okStream = `${threadLine}\n${messageLine}\n${turnLine}\n`;

function baseOpts(onEvent: (e: CodingEvent) => void = () => {}) {
  return { prompt: "implement it", cwd: "/tmp/wt", model: "gpt-5-codex", onEvent };
}

const flagValue = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

beforeEach(() => {
  vi.mocked(invalidateResolvedCodex).mockClear();
});

describe("runCodexCodingAgent argv", () => {
  it("builds a workspace-write sandboxed fresh run reading the prompt from stdin", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;

    const { file, args, opts } = calls[0];
    expect(file).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume");
    expect(flagValue(args, "--model")).toBe("gpt-5-codex");
    expect(flagValue(args, "--sandbox")).toBe("workspace-write");
    expect(flagValue(args, "-C")).toBe("/tmp/wt");
    expect(args).toContain("--json");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("project_doc_max_bytes=0");
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args[args.length - 1]).toBe("-");
    expect(opts.cwd).toBe("/tmp/wt");
    expect(child.stdin.written).toBe("implement it");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  // #240: the runtime is constructed without a model when the role's Claude alias
  // would otherwise leak here — codex then runs on its own configured default.
  it("omits --model entirely when the caller set none", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodexCodingAgent({ ...baseOpts(), model: undefined }, spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(calls[0].args).not.toContain("--model");
    expect(calls[0].args).toContain("--sandbox");
  });

  // The on-disk session is the shepherd's re-entry seam (#11) — unlike the
  // agent/structured calls, a coding run must never be ephemeral.
  it("never passes --ephemeral on a coding run", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(calls[0].args).not.toContain("--ephemeral");
  });

  it("re-enters through the resume subcommand right after exec", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodexCodingAgent(
      { ...baseOpts(), resumeSessionId: THREAD_ID },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(calls[0].args.slice(0, 3)).toEqual(["exec", "resume", THREAD_ID]);
  });

  it("TOML-encodes the skipper-memory MCP server as -c overrides (#45)", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodexCodingAgent(
      {
        ...baseOpts(),
        memory: {
          cliBundlePath: "/app/skipper.bundle.cjs",
          repo: { owner: "Cicababba", name: "Skipper" },
        },
      },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;

    const args = calls[0].args;
    expect(args).toContain(`mcp_servers.skipper-memory.command=${JSON.stringify(process.execPath)}`);
    expect(args).toContain(
      'mcp_servers.skipper-memory.args=["/app/skipper.bundle.cjs","memory","serve","--repo","cicababba/skipper"]',
    );
    expect(args).toContain('mcp_servers.skipper-memory.env={ELECTRON_RUN_AS_NODE="1"}');
  });

  it("carries the system prompt as a developer_instructions override", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodexCodingAgent(
      { ...baseOpts(), systemPrompt: 'be terse\nsay "ok"' },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(calls[0].args).toContain('developer_instructions="be terse\\nsay \\"ok\\""');
  });

  // Both options belong to the claude runtime: codex has no turn budget and its
  // native sandbox replaces the rules/hook machinery (#239 D7).
  it("ignores confinement and maxTurns entirely", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const { child, spawnImpl, calls } = fakeSpawn();
      const promise = runCodexCodingAgent({ ...baseOpts(), ...extra }, spawnImpl);
      child.stdout.emit("data", Buffer.from(okStream));
      child.emit("close", 0);
      await promise;
      return calls[0].args;
    };
    const plain = await run({});
    const decorated = await run({
      maxTurns: 300,
      confinement: {
        runRoot: "/tmp/wt",
        denyRoots: ["/home/me/repo"],
        cliBundlePath: "/app/skipper.bundle.cjs",
      },
    });
    expect(decorated).toEqual(plain);
    expect(decorated.join(" ")).not.toContain("300");
    expect(decorated).not.toContain("--settings");
  });
});

describe("runCodexCodingAgent result", () => {
  it("synthesizes the result event codex never sends and resolves on it", async () => {
    const events: CodingEvent[] = [];
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts((e) => events.push(e)), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${threadLine}\n`));
    child.stdout.emit("data", Buffer.from(`${messageLine}\n${turnLine}\n`));
    child.emit("close", 0);
    const result = await promise;

    expect(events.map((e) => e.kind)).toEqual(["agent-init", "text", "result"]);
    expect(events[2]).toEqual({
      kind: "result",
      ok: true,
      summary: "done",
      turns: 1,
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
    expect(result).toEqual({
      ok: true,
      summary: "done",
      resultText: "done",
      sessionId: THREAD_ID,
      turns: 1,
    });
  });

  // Codex mints its own id, so a pre-minted sessionId is ignored and the driver
  // re-stamps the manifest from the thread id on the stream.
  it("returns the minted thread id over a pre-minted sessionId", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCodexCodingAgent(
      { ...baseOpts(), sessionId: "22222222-2222-4222-8222-222222222222" },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    const result = await promise;
    expect(result.sessionId).toBe(THREAD_ID);
    expect(calls[0].args.join(" ")).not.toContain("22222222-2222-4222-8222-222222222222");
  });

  it("falls back to the requested session id when the stream carried none", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodexCodingAgent(
      { ...baseOpts(), resumeSessionId: "33333333-3333-4333-8333-333333333333" },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${messageLine}\n`));
    child.emit("close", 0);
    expect((await promise).sessionId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("keeps the full result text while the summary stays capped (#146)", async () => {
    const big = "x".repeat(3000);
    const bigLine = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: big },
    });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${threadLine}\n${bigLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(result.resultText).toBe(big);
    expect(result.summary.length).toBe(2000);
  });

  it("resolves a failed turn as a non-ok result instead of rejecting", async () => {
    const failLine = JSON.stringify({ type: "turn.failed", error: { message: "model refused" } });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${threadLine}\n${failLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("model refused");
    expect(result.sessionId).toBe(THREAD_ID);
  });

  it("marks the result not-ok when codex exits nonzero after streaming", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 3);
    expect((await promise).ok).toBe(false);
  });

  it("rejects with the stderr tail when codex dies before emitting anything", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts(), spawnImpl);
    child.stderr.emit("data", Buffer.from("sandbox init failed"));
    child.emit("close", 1);
    await expect(promise).rejects.toThrow(/exited with code 1.*sandbox init failed/s);
  });
});

describe("runCodexCodingAgent guards", () => {
  it("abort kills the tree and rejects with CodingAbortError", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const controller = new AbortController();
    const promise = runCodexCodingAgent({ ...baseOpts(), signal: controller.signal }, spawnImpl);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(CodingAbortError);
    expect(child.killed).toContain("SIGTERM");
  });

  it("escalates SIGTERM to SIGKILL after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnImpl } = fakeSpawn();
      const controller = new AbortController();
      const promise = runCodexCodingAgent({ ...baseOpts(), signal: controller.signal }, spawnImpl);
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
      const { child, spawnImpl } = fakeSpawn();
      const promise = runCodexCodingAgent({ ...baseOpts(), inactivityTimeoutMs: 1000 }, spawnImpl);
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
      const { child, spawnImpl } = fakeSpawn();
      const promise = runCodexCodingAgent(
        { ...baseOpts(), inactivityTimeoutMs: 60_000, hardTimeoutMs: 2000 },
        spawnImpl,
      );
      const settled = promise.catch((e) => e);
      vi.advanceTimersByTime(1500);
      child.stdout.emit("data", Buffer.from(`${threadLine}\n`)); // keeps inactivity fresh
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

  it("invalidates the memoized resolution when codex is missing (ENOENT)", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts(), spawnImpl);
    const err: NodeJS.ErrnoException = new Error("spawn codex ENOENT");
    err.code = "ENOENT";
    child.emit("error", err);
    await expect(promise).rejects.toThrow(/ENOENT/);
    expect(invalidateResolvedCodex).toHaveBeenCalled();
  });

  it("does not invalidate the resolution on an unrelated spawn error", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCodexCodingAgent(baseOpts(), spawnImpl);
    child.emit("error", new Error("EPIPE"));
    await expect(promise).rejects.toThrow(/EPIPE/);
    expect(invalidateResolvedCodex).not.toHaveBeenCalled();
  });
});
