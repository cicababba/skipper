import { spawn } from "node:child_process";
import {
  buildGeminiProjectSettings,
  buildGeminiPrompt,
  geminiBaseArgs,
  geminiSessionArgs,
  invalidateResolvedGemini,
  resolveGemini,
} from "../llm/gemini-cli";
import { createGeminiRunAccumulator } from "../llm/gemini-stream";
import {
  CodingAbortError,
  CodingTimeoutError,
  type CodingRunResult,
  type RunCodingAgentOptions,
} from "./run";

const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60_000;
const SIGKILL_ESCALATION_MS = 3_000;

/**
 * The gemini-cli coding run (#243). Same contract as runCodingAgent — the driver
 * reads the same CodingRunResult and salvages on the same typed errors — with
 * three runtime differences:
 *  - gemini confines nothing on its own (its native sandbox needs docker/podman),
 *    so opts.confinement is accepted-ignored and the worktree tripwire is the
 *    only guard; `--approval-mode=yolo` is what makes a headless run able to
 *    write at all, since any tool that would prompt is auto-denied otherwise;
 *  - opts.maxTurns has no per-run gemini equivalent (maxSessionTurns is
 *    cumulative per session), so the wall-clock timers are the whole budget;
 *  - the session id is pre-minted by the driver and passed as --session-id, so
 *    it round-trips unchanged unless the init event reports a different one.
 *
 * The project settings file gemini needs for GEMINI.md suppression and MCP lives
 * inside the worktree, so its cleanup runs on every exit path — settle, abort and
 * timer kill alike.
 */
export function runGeminiCodingAgent(
  opts: RunCodingAgentOptions,
  spawnImpl: typeof spawn = spawn,
): Promise<CodingRunResult> {
  return new Promise((resolve, reject) => {
    const gemini = resolveGemini();
    const settings = buildGeminiProjectSettings(opts.cwd, opts.memory);
    const args = [
      ...gemini.argsPrefix,
      ...geminiBaseArgs(),
      ...(opts.model ? ["-m", opts.model] : []),
      "--approval-mode=yolo",
      ...geminiSessionArgs(opts.sessionId, opts.resumeSessionId),
      ...settings.args,
    ];

    // No -C equivalent: gemini takes its project scope (settings file, session
    // store) from the process cwd.
    const proc = spawnImpl(gemini.file, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(gemini.env ? { env: gemini.env } : {}),
    });

    let stderr = "";
    let settled = false;
    let aborted = false;
    let inactivityTimer: NodeJS.Timeout | null = null;

    const killTree = () => {
      proc.kill("SIGTERM");
      const escalate = setTimeout(() => proc.kill("SIGKILL"), SIGKILL_ESCALATION_MS);
      escalate.unref?.();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const inactivityMs = opts.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    const hardMs = opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;

    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fail(
          new CodingTimeoutError(
            "coding agent produced no output for too long — killed as hung",
            "inactivity",
            inactivityMs,
          ),
        );
        killTree();
      }, inactivityMs);
    };

    const hardTimer = setTimeout(() => {
      fail(
        new CodingTimeoutError(
          "coding run exceeded the hard time limit — killed",
          "hard_timeout",
          hardMs,
        ),
      );
      killTree();
    }, hardMs);

    const onAbort = () => {
      aborted = true;
      fail(new CodingAbortError());
      killTree();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(hardTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      settings.cleanup();
    };

    let sawStream = false;
    const accumulator = createGeminiRunAccumulator((event) => {
      sawStream = true;
      opts.onEvent(event);
    }, opts.sessionId ?? opts.resumeSessionId);

    proc.stdout.on("data", (data: Buffer) => {
      resetInactivity();
      accumulator.feed(data.toString());
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      accumulator.flush();
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(new CodingAbortError());
        return;
      }
      // Gemini's own result line only overrides the outcome the stream already
      // built, so a crash without one still yields exactly one result event.
      const outcome = accumulator.finish();
      if (!sawStream && code !== 0) {
        reject(
          new Error(`gemini exited with code ${code} without a result: ${stderr.slice(-2000)}`),
        );
        return;
      }
      const ok = outcome.event.ok && (code === 0 || code === null);
      const event = { ...outcome.event, ok };
      opts.onEvent(event);
      resolve({
        ok,
        summary: event.summary ?? "",
        sessionId: outcome.sessionId ?? opts.resumeSessionId ?? opts.sessionId ?? "",
        ...(outcome.resultText !== undefined ? { resultText: outcome.resultText } : {}),
        ...(event.turns !== undefined ? { turns: event.turns } : {}),
      });
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") invalidateResolvedGemini();
      fail(err);
    });

    resetInactivity();
    proc.stdin.write(buildGeminiPrompt(opts.systemPrompt, opts.prompt));
    proc.stdin.end();
  });
}
