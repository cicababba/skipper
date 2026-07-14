import { spawn } from "node:child_process";
import type { CodingEvent } from "@skipper/shared";
import { invalidateResolvedClaude, resolveClaude } from "../llm/claude-cli";
import { createStreamJsonParser } from "../llm/stream";

const CODER_TOOLS = "Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch";
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60_000;
const SIGKILL_ESCALATION_MS = 3_000;

export class CodingAbortError extends Error {
  constructor() {
    super("coding run aborted");
    this.name = "CodingAbortError";
  }
}

export interface RunCodingAgentOptions {
  prompt: string;
  systemPrompt?: string;
  /** Worktree path — sessions are cwd-scoped, resume must use the same path. */
  cwd: string;
  model: string;
  maxTurns?: number;
  /** Fresh run: session id to mint the on-disk session under (UUID). */
  sessionId?: string;
  /** Re-entry: resume an existing session. Mutually exclusive with sessionId. */
  resumeSessionId?: string;
  onEvent: (event: CodingEvent) => void;
  signal?: AbortSignal;
  /** Reset on every stdout line; a silent agent past this is hung. */
  inactivityTimeoutMs?: number;
  hardTimeoutMs?: number;
}

export interface CodingRunResult {
  ok: boolean;
  summary: string;
  /** From the init event (authoritative). */
  sessionId: string;
  turns?: number;
}

export function runCodingAgent(
  opts: RunCodingAgentOptions,
  spawnImpl: typeof spawn = spawn,
): Promise<CodingRunResult> {
  return new Promise((resolve, reject) => {
    const claude = resolveClaude();
    const args = [
      ...claude.argsPrefix,
      "-p",
      "-",
      "--output-format",
      "stream-json",
      "--verbose", // stream-json requires it in print mode
      "--model",
      opts.model,
      "--max-turns",
      String(opts.maxTurns ?? DEFAULT_MAX_TURNS),
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--tools",
      CODER_TOOLS,
      "--allowedTools",
      CODER_TOOLS,
    ];
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    // No --no-session-persistence (unlike ask/agent): the on-disk session is
    // the re-entry seam for shepherding (#11).
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    else if (opts.sessionId) args.push("--session-id", opts.sessionId);

    const proc = spawnImpl(claude.file, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(claude.env ? { env: claude.env } : {}),
    });

    let stderr = "";
    let sessionId = opts.resumeSessionId ?? opts.sessionId ?? "";
    let result: CodingRunResult | null = null;
    let settled = false;
    let aborted = false;
    let inactivityTimer: NodeJS.Timeout | null = null;

    const killTree = () => {
      proc.kill("SIGTERM");
      // On Windows proc.kill terminates only the claude process; Bash-tool
      // grandchildren linger until the app-quit taskkill /F /T failsafe.
      const escalate = setTimeout(() => proc.kill("SIGKILL"), SIGKILL_ESCALATION_MS);
      escalate.unref?.();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fail(new Error("coding agent produced no output for too long — killed as hung"));
        killTree();
      }, opts.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS);
    };

    const hardTimer = setTimeout(() => {
      fail(new Error("coding run exceeded the hard time limit — killed"));
      killTree();
    }, opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS);

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

    const parser = createStreamJsonParser((event) => {
      if (event.kind === "agent-init") sessionId = event.sessionId;
      if (event.kind === "result") {
        result = {
          ok: event.ok,
          summary: event.summary ?? "",
          sessionId,
          ...(event.turns !== undefined ? { turns: event.turns } : {}),
        };
      }
      opts.onEvent(event);
    });

    proc.stdout.on("data", (data: Buffer) => {
      resetInactivity();
      parser.feed(data.toString());
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      parser.flush();
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(new CodingAbortError());
      } else if (result) {
        resolve(result);
      } else {
        reject(new Error(`claude exited with code ${code} without a result: ${stderr.slice(-2000)}`));
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") invalidateResolvedClaude();
      fail(err);
    });

    resetInactivity();
    proc.stdin.write(opts.prompt);
    proc.stdin.end();
  });
}
