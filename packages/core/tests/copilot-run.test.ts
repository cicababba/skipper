import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { spawn } from "node:child_process";
import type { CodingEvent } from "@skipper/shared";
import { CodingAbortError, CodingTimeoutError } from "../src/coder/run";
import { runCopilotCodingAgent } from "../src/coder/copilot-run";
import { invalidateResolvedCopilot } from "../src/llm/copilot-cli";

// Real argv builders (the temp MCP config is really written and really deleted),
// mocked invalidation — the ENOENT path is asserted through the spy, not by
// re-resolving copilot on the test machine.
vi.mock("../src/llm/copilot-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/copilot-cli")>();
  return { ...actual, invalidateResolvedCopilot: vi.fn() };
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

// BEST-EFFORT FIXTURES (#242): the JSONL schema is undocumented, so these lines
// use the community-captured event names with the field shapes the mapper guesses.
const SESSION_ID = "7f3a1c2e-9b4d-4e6a-8f1b-2c3d4e5f6a7b";
const messageLine = JSON.stringify({ type: "assistant.message", text: "done" });
const turnLine = JSON.stringify({
  type: "assistant.turn_end",
  usage: { input_tokens: 1200, output_tokens: 80 },
});
const okStream = `${messageLine}\n${turnLine}\n`;

function baseOpts(onEvent: (e: CodingEvent) => void = () => {}) {
  return {
    prompt: "implement it",
    cwd: "/tmp/wt",
    model: "claude-sonnet-4.5",
    sessionId: SESSION_ID,
    onEvent,
  };
}

const flagValue = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

beforeEach(() => {
  vi.mocked(invalidateResolvedCopilot).mockClear();
});

describe("runCopilotCodingAgent argv", () => {
  it("builds a fresh run under the pre-minted session id, prompt on stdin", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;

    const { file, args, opts } = calls[0];
    expect(file).toBe("copilot");
    expect(flagValue(args, "--output-format")).toBe("json");
    expect(args).toContain("--no-ask-user");
    expect(args).toContain("--no-custom-instructions");
    expect(flagValue(args, "--model")).toBe("claude-sonnet-4.5");
    expect(flagValue(args, "--session-id")).toBe(SESSION_ID);
    expect(args).not.toContain("--resume");
    expect(flagValue(args, "-C")).toBe("/tmp/wt");
    expect(args).toContain("--allow-all-tools");
    expect(flagValue(args, "--deny-tool")).toBe("github");
    expect(opts.cwd).toBe("/tmp/wt");
    // The prompt rides on stdin: a Windows argv is capped around 32KB and coding
    // prompts blow past it (#242 D10).
    expect(child.stdin.written).toBe("implement it");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  // Writes are confined to the cwd by copilot's own path verification; passing
  // this flag would disable exactly the guarantee the worktree relies on.
  it("never passes --allow-all-paths", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(calls[0].args).not.toContain("--allow-all-paths");
  });

  // #240: the runtime is constructed without a model when the role's Claude alias
  // would otherwise leak here — copilot then runs on its own configured default.
  it("omits --model entirely when the caller set none", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCopilotCodingAgent({ ...baseOpts(), model: undefined }, spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(calls[0].args).not.toContain("--model");
  });

  it("re-enters with --resume and drops --session-id", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCopilotCodingAgent(
      { ...baseOpts(), sessionId: undefined, resumeSessionId: SESSION_ID },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(flagValue(calls[0].args, "--resume")).toBe(SESSION_ID);
    expect(calls[0].args).not.toContain("--session-id");
  });

  it("prefers resume over a pre-minted id when both are set", async () => {
    const resumeId = "33333333-3333-4333-8333-333333333333";
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCopilotCodingAgent(
      { ...baseOpts(), resumeSessionId: resumeId },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(flagValue(calls[0].args, "--resume")).toBe(resumeId);
    expect(calls[0].args).not.toContain("--session-id");
  });

  it("prefixes the system prompt onto the stdin prompt (#242 D6)", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(
      { ...baseOpts(), systemPrompt: "be terse" },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(child.stdin.written).toBe("<system>\nbe terse\n</system>\n\nimplement it");
  });

  // Both options belong to the claude runtime: copilot has no turn budget and its
  // native path verification replaces the rules/hook machinery (#242 D7).
  it("ignores confinement, maxTurns and graph entirely", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const { child, spawnImpl, calls } = fakeSpawn();
      const promise = runCopilotCodingAgent({ ...baseOpts(), ...extra }, spawnImpl);
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

describe("runCopilotCodingAgent memory MCP (#45)", () => {
  const memory = {
    cliBundlePath: "/app/skipper.bundle.cjs",
    repo: { owner: "Cicababba", name: "Skipper" },
  };

  it("writes the skipper-memory server to a temp config and passes it by path", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCopilotCodingAgent({ ...baseOpts(), memory }, spawnImpl);
    const configPath = flagValue(calls[0].args, "--additional-mcp-config");
    const written = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(written).toEqual({
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

    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(existsSync(dirname(configPath))).toBe(false);
  });

  it("passes no MCP flag at all when the run has no memory", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    await promise;
    expect(calls[0].args).not.toContain("--additional-mcp-config");
  });

  it("releases the temp config when the run is killed instead of closing", async () => {
    const { child, spawnImpl, calls } = fakeSpawn();
    const controller = new AbortController();
    const promise = runCopilotCodingAgent(
      { ...baseOpts(), memory, signal: controller.signal },
      spawnImpl,
    );
    const configDir = dirname(flagValue(calls[0].args, "--additional-mcp-config"));
    expect(existsSync(configDir)).toBe(true);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(CodingAbortError);
    expect(existsSync(configDir)).toBe(false);
    expect(child.killed).toContain("SIGTERM");
  });
});

describe("runCopilotCodingAgent result", () => {
  it("emits exactly one terminal result event and resolves on it", async () => {
    const events: CodingEvent[] = [];
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts((e) => events.push(e)), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${messageLine}\n`));
    child.stdout.emit("data", Buffer.from(`${turnLine}\n`));
    child.emit("close", 0);
    const result = await promise;

    expect(events.map((e) => e.kind)).toEqual(["agent-init", "text", "result"]);
    expect(events.filter((e) => e.kind === "result")).toHaveLength(1);
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
      sessionId: SESSION_ID,
      turns: 1,
    });
  });

  // Copilot's own result line is an override, not the event source — a run that
  // sends one still reports a single terminal result.
  it("folds copilot's own result line into the one terminal event", async () => {
    const events: CodingEvent[] = [];
    const resultLine = JSON.stringify({ type: "result", result: "3 files changed", num_turns: 7 });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts((e) => events.push(e)), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${messageLine}\n${resultLine}\n`));
    child.emit("close", 0);
    const result = await promise;

    expect(events.filter((e) => e.kind === "result")).toHaveLength(1);
    expect(result.summary).toBe("3 files changed");
    expect(result.resultText).toBe("done");
    expect(result.turns).toBe(7);
  });

  it("round-trips the pre-minted session id when the stream carries none", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 0);
    expect((await promise).sessionId).toBe(SESSION_ID);
  });

  it("prefers a session id carried by the stream over the pre-minted one", async () => {
    const carried = "44444444-4444-4444-8444-444444444444";
    const carriedLine = JSON.stringify({ type: "assistant.turn_start", session_id: carried });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${carriedLine}\n${okStream}`));
    child.emit("close", 0);
    expect((await promise).sessionId).toBe(carried);
  });

  it("falls back to the resumed id when neither stream nor pre-mint provided one", async () => {
    const resumeId = "55555555-5555-4555-8555-555555555555";
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(
      { ...baseOpts(), sessionId: undefined, resumeSessionId: resumeId },
      spawnImpl,
    );
    child.stdout.emit("data", Buffer.from(`${messageLine}\n`));
    child.emit("close", 0);
    expect((await promise).sessionId).toBe(resumeId);
  });

  it("keeps the full result text while the summary stays capped (#146)", async () => {
    const big = "x".repeat(3000);
    const bigLine = JSON.stringify({ type: "assistant.message", text: big });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${bigLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(result.resultText).toBe(big);
    expect(result.summary.length).toBe(2000);
  });

  it("resolves a stream failure as a non-ok result instead of rejecting", async () => {
    const errorLine = JSON.stringify({ type: "error", message: "model refused" });
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(`${errorLine}\n`));
    child.emit("close", 0);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("model refused");
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it("marks the result not-ok when copilot exits nonzero after streaming", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stdout.emit("data", Buffer.from(okStream));
    child.emit("close", 3);
    expect((await promise).ok).toBe(false);
  });

  it("rejects with the stderr tail when copilot dies before emitting anything", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.stderr.emit("data", Buffer.from("unknown option --no-custom-instructions"));
    child.emit("close", 1);
    await expect(promise).rejects.toThrow(
      /exited with code 1.*unknown option --no-custom-instructions/s,
    );
  });
});

describe("runCopilotCodingAgent guards", () => {
  it("abort kills the tree and rejects with CodingAbortError", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const controller = new AbortController();
    const promise = runCopilotCodingAgent({ ...baseOpts(), signal: controller.signal }, spawnImpl);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(CodingAbortError);
    expect(child.killed).toContain("SIGTERM");
  });

  it("escalates SIGTERM to SIGKILL after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnImpl } = fakeSpawn();
      const controller = new AbortController();
      const promise = runCopilotCodingAgent({ ...baseOpts(), signal: controller.signal }, spawnImpl);
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
      const promise = runCopilotCodingAgent({ ...baseOpts(), inactivityTimeoutMs: 1000 }, spawnImpl);
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
      const promise = runCopilotCodingAgent(
        { ...baseOpts(), inactivityTimeoutMs: 60_000, hardTimeoutMs: 2000 },
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

  it("invalidates the memoized resolution when copilot is missing (ENOENT)", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    const err: NodeJS.ErrnoException = new Error("spawn copilot ENOENT");
    err.code = "ENOENT";
    child.emit("error", err);
    await expect(promise).rejects.toThrow(/ENOENT/);
    expect(invalidateResolvedCopilot).toHaveBeenCalled();
  });

  it("does not invalidate the resolution on an unrelated spawn error", async () => {
    const { child, spawnImpl } = fakeSpawn();
    const promise = runCopilotCodingAgent(baseOpts(), spawnImpl);
    child.emit("error", new Error("EPIPE"));
    await expect(promise).rejects.toThrow(/EPIPE/);
    expect(invalidateResolvedCopilot).not.toHaveBeenCalled();
  });
});
