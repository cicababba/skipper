import { spawn } from "node:child_process";
import type { CodingEvent } from "@skipper/shared";
import { invalidateResolvedClaude, resolveClaude } from "../llm/claude-cli";
import { createStreamJsonParser } from "../llm/stream";
import { MEMORY_TOOLS, buildMemoryMcpArgs, type MemoryMcp } from "../llm/memory-mcp";
import {
  buildConfinementSettingsArgs,
  confinementEnv,
  scopedWriteRules,
  type RunConfinement,
} from "../llm/confinement";

const CODER_TOOLS = "Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch";
// Same set minus the write tools — the write tools are pre-approved path-scoped
// to the run root instead (L1 confinement, #196), never as bare names.
const CODER_NONWRITE_TOOLS = "Read,Grep,Glob,Bash,WebFetch,WebSearch";
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
  /** Inject the skipper-memory MCP server, scoped to the item's repo (#45). */
  memory?: MemoryMcp;
  /** Keep the run inside its worktree (#196): adds the Bash/Edit/Write guard hook
   *  and the confined spawn env. L1 write-scoping to opts.cwd is unconditional. */
  confinement?: RunConfinement;
}

export interface CodingRunResult {
  ok: boolean;
  summary: string;
  /** Full untruncated final message — the structured report path reads this,
   *  since summary is capped at SUMMARY_MAX (#146). */
  resultText?: string;
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
    // Solutions-memory MCP is opt-in (#45): only wired when the caller passes
    // opts.memory. Tool names must join both --tools and --allowedTools —
    // headless -p auto-denies an un-pre-approved tool.
    const tools = opts.memory ? `${CODER_TOOLS},${MEMORY_TOOLS}` : CODER_TOOLS;
    // L1 confinement (#196): --tools keeps the bare names, but --allowedTools
    // pre-approves the write tools only path-scoped to the run root, so an
    // absolute-path Edit/Write anywhere else on disk is auto-denied. Scoping is
    // unconditional — a coder write outside its worktree is a bug by contract.
    const nonWrite = opts.memory ? `${CODER_NONWRITE_TOOLS},${MEMORY_TOOLS}` : CODER_NONWRITE_TOOLS;
    const allowedTools = [nonWrite, ...scopedWriteRules(opts.cwd)].join(",");
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
      tools,
      "--allowedTools",
      allowedTools,
      ...(opts.memory ? buildMemoryMcpArgs(opts.memory) : []),
      ...(opts.confinement ? buildConfinementSettingsArgs(opts.confinement) : []),
    ];
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    // No --no-session-persistence (unlike ask/agent): the on-disk session is
    // the re-entry seam for shepherding (#11).
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    else if (opts.sessionId) args.push("--session-id", opts.sessionId);

    const env = confinementEnv(opts.confinement, claude.env);
    const proc = spawnImpl(claude.file, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env } : {}),
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

    // onLine fires before the mapped result event for the same line, so the
    // full untruncated result text is already captured when we build result.
    let resultText: string | undefined;
    const parser = createStreamJsonParser(
      (event) => {
        if (event.kind === "agent-init") sessionId = event.sessionId;
        if (event.kind === "result") {
          result = {
            ok: event.ok,
            summary: event.summary ?? "",
            sessionId,
            ...(resultText !== undefined ? { resultText } : {}),
            ...(event.turns !== undefined ? { turns: event.turns } : {}),
          };
        }
        opts.onEvent(event);
      },
      (line) => {
        if (line.type === "result" && typeof line.result === "string") resultText = line.result;
      },
    );

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
