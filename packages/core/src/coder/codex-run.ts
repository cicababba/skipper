import { spawn } from "node:child_process";
import {
  codexConfigArgs,
  invalidateResolvedCodex,
  resolveCodex,
} from "../llm/codex-cli";
import { createCodexRunAccumulator } from "../llm/codex-stream";
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
 * The codex-cli coding run (#239). Same contract as runCodingAgent — the driver
 * reads the same CodingRunResult and salvages on the same typed errors — with
 * three runtime differences:
 *  - confinement is codex's native `workspace-write` sandbox rooted at opts.cwd,
 *    so opts.confinement (the claude rules/hook machinery) is accepted-ignored;
 *  - opts.maxTurns has no codex equivalent, so the wall-clock timers are the
 *    whole budget (a max-turns death can never happen here);
 *  - codex mints its own thread id, so opts.sessionId is accepted-ignored and
 *    the id comes back from the stream (the driver re-stamps the manifest).
 */
export function runCodexCodingAgent(
  opts: RunCodingAgentOptions,
  spawnImpl: typeof spawn = spawn,
): Promise<CodingRunResult> {
  return new Promise((resolve, reject) => {
    const codex = resolveCodex();
    const args = [
      ...codex.argsPrefix,
      "exec",
      ...(opts.resumeSessionId ? ["resume", opts.resumeSessionId] : []),
      "--json",
      ...(opts.model ? ["--model", opts.model] : []),
      "--sandbox",
      "workspace-write",
      "-C",
      opts.cwd,
      // The claude rules never blocked network access — keep parity.
      "-c",
      "sandbox_workspace_write.network_access=true",
      ...codexConfigArgs({ memory: opts.memory, systemPrompt: opts.systemPrompt }),
      "-",
    ];

    // No --ephemeral (unlike agent/structured): the on-disk session is the
    // re-entry seam for shepherding (#11).
    const proc = spawnImpl(codex.file, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(codex.env ? { env: codex.env } : {}),
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
        new CodingTimeoutError("coding run exceeded the hard time limit — killed", "hard_timeout", hardMs),
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
    };

    let sawStream = false;
    const accumulator = createCodexRunAccumulator((event) => {
      sawStream = true;
      opts.onEvent(event);
    });

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
      // Codex emits no terminal result line — synthesize one from the stream.
      const outcome = accumulator.finish();
      if (!sawStream && code !== 0) {
        reject(new Error(`codex exited with code ${code} without a result: ${stderr.slice(-2000)}`));
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
      if (err.code === "ENOENT") invalidateResolvedCodex();
      fail(err);
    });

    resetInactivity();
    proc.stdin.write(opts.prompt);
    proc.stdin.end();
  });
}
