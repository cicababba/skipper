import { spawn } from "node:child_process";
import {
  buildCopilotMcpConfig,
  buildCopilotPrompt,
  copilotBaseArgs,
  invalidateResolvedCopilot,
  resolveCopilot,
} from "../llm/copilot-cli";
import { createCopilotRunAccumulator } from "../llm/copilot-stream";
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
 * The copilot-cli coding run (#242). Same contract as runCodingAgent — the
 * driver reads the same CodingRunResult and salvages on the same typed errors —
 * with three runtime differences:
 *  - confinement is copilot's own path verification, which keeps writes inside
 *    the cwd and the --add-dir roots, so opts.confinement (the claude rules/hook
 *    machinery) is accepted-ignored and --allow-all-paths is never passed;
 *  - opts.maxTurns has no copilot equivalent, so the wall-clock timers are the
 *    whole budget (a max-turns death can never happen here);
 *  - the session id is pre-minted by the driver and passed as --session-id, so
 *    it round-trips unchanged unless the stream reports a different one.
 */
export function runCopilotCodingAgent(
  opts: RunCodingAgentOptions,
  spawnImpl: typeof spawn = spawn,
): Promise<CodingRunResult> {
  return new Promise((resolve, reject) => {
    const copilot = resolveCopilot();
    const mcp = opts.memory ? buildCopilotMcpConfig(opts.memory) : undefined;
    const args = [
      ...copilot.argsPrefix,
      ...copilotBaseArgs(),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.resumeSessionId
        ? ["--resume", opts.resumeSessionId]
        : opts.sessionId
          ? ["--session-id", opts.sessionId]
          : []),
      "-C",
      opts.cwd,
      // Parity with the claude run's unrestricted Bash: a curated allowlist
      // against copilot's undocumented tool names would auto-deny silently and
      // stall a --no-ask-user run. Writes stay confined by path verification.
      "--allow-all-tools",
      // Best-effort suppression of copilot's built-in GitHub tools: the coder
      // must not touch the issue tracker. A wrong name here is a no-op (R5).
      "--deny-tool",
      "github",
      ...(mcp ? mcp.args : []),
    ];

    const proc = spawnImpl(copilot.file, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(copilot.env ? { env: copilot.env } : {}),
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
      mcp?.cleanup();
    };

    let sawStream = false;
    const accumulator = createCopilotRunAccumulator((event) => {
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
      // Copilot's own result line only overrides the outcome the stream already
      // built, so a crash without one still yields exactly one result event.
      const outcome = accumulator.finish();
      if (!sawStream && code !== 0) {
        reject(
          new Error(`copilot exited with code ${code} without a result: ${stderr.slice(-2000)}`),
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
      if (err.code === "ENOENT") invalidateResolvedCopilot();
      fail(err);
    });

    resetInactivity();
    proc.stdin.write(buildCopilotPrompt(opts.systemPrompt, opts.prompt));
    proc.stdin.end();
  });
}
