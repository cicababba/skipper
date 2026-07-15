import { spawn } from "node:child_process";
import type { CodingEvent, LLMProvider } from "@skipper/shared";
import { invalidateResolvedClaude, resolveClaude } from "../llm/claude-cli";
import {
  CODEX_NOT_INSTALLED,
  invalidateResolvedCodex,
  killCodexTree,
  modelFlag,
  resolveCodex,
  codexEnv,
  tomlString,
} from "../llm/codex-cli";
import { createStreamJsonParser, type StreamJsonParser } from "../llm/stream";
import { createCodexStreamParser } from "../llm/stream-codex";
import { MEMORY_TOOLS, buildMemoryMcpArgs, type MemoryMcp } from "../llm/memory-mcp";

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
  /** Defaults to claude-cli — the only coder backend before #67. */
  provider?: LLMProvider;
  /** Codex authenticates per-invocation via CODEX_API_KEY. */
  apiKey?: string;
  /** Ignored on codex-cli: it has no --max-turns and no config equivalent, so
   *  only the inactivity/hard timeouts bound a run there. */
  maxTurns?: number;
  /** Fresh run: session id to mint the on-disk session under (UUID).
   *  Ignored on codex-cli, which mints its own thread_id — the init event is
   *  authoritative there. */
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
}

export interface CodingRunResult {
  ok: boolean;
  summary: string;
  /** From the init event (authoritative). */
  sessionId: string;
  turns?: number;
}

interface CoderBackend {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Own process group, so a kill reaches the shells the agent spawned. */
  detached: boolean;
  createParser: (onEvent: (event: CodingEvent) => void) => StreamJsonParser;
  /** Drop the memoized binary resolution when the spawn 404s. */
  invalidate: () => void;
  notInstalled: string;
  label: string;
}

function claudeBackend(opts: RunCodingAgentOptions): CoderBackend {
  const claude = resolveClaude();
  // Solutions-memory MCP is opt-in (#45): only wired when the caller passes
  // opts.memory. Tool names must join both --tools and --allowedTools —
  // headless -p auto-denies an un-pre-approved tool.
  const tools = opts.memory ? `${CODER_TOOLS},${MEMORY_TOOLS}` : CODER_TOOLS;
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
    tools,
    ...(opts.memory ? buildMemoryMcpArgs(opts.memory) : []),
  ];
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  // No --no-session-persistence (unlike ask/agent): the on-disk session is
  // the re-entry seam for shepherding (#11).
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  else if (opts.sessionId) args.push("--session-id", opts.sessionId);

  return {
    file: claude.file,
    args,
    ...(claude.env ? { env: claude.env } : {}),
    detached: false,
    createParser: (onEvent) => createStreamJsonParser(onEvent),
    invalidate: invalidateResolvedClaude,
    notInstalled: "",
    label: "claude",
  };
}

function codexBackend(opts: RunCodingAgentOptions): CoderBackend {
  const codex = resolveCodex();
  const env = codexEnv(opts.apiKey);
  // Flags MUST precede the `resume` subcommand — codex rejects them after it
  // (`unexpected argument '--sandbox'`, exit 2). -C and --sandbox are honored
  // here despite being absent from `codex exec resume --help`.
  const args = [
    ...codex.argsPrefix,
    "exec",
    "--json",
    "--ignore-user-config",
    "-c",
    "project_doc_max_bytes=0",
    "--sandbox",
    "workspace-write",
    "-C",
    opts.cwd,
    "--skip-git-repo-check",
    ...modelFlag(opts.model),
    ...(opts.systemPrompt
      ? ["-c", `developer_instructions=${tomlString(opts.systemPrompt)}`]
      : []),
  ];
  // No --ephemeral (unlike ask/agent): the persisted session is the re-entry
  // seam for shepherding (#11). Codex mints its own thread_id — there is no
  // --session-id equivalent, so opts.sessionId can't be honored and the
  // thread.started event is the authoritative id.
  if (opts.resumeSessionId) args.push("resume", opts.resumeSessionId);
  // `-` reads the prompt from stdin: dodges argv limits, and closing the pipe
  // is what keeps us out of codex's non-TTY stdin deadlock.
  args.push("-");

  return {
    file: codex.file,
    args,
    ...(env ? { env } : {}),
    detached: process.platform !== "win32",
    createParser: (onEvent) => createCodexStreamParser(onEvent),
    invalidate: invalidateResolvedCodex,
    notInstalled: CODEX_NOT_INSTALLED,
    label: "codex",
  };
}

export function runCodingAgent(
  opts: RunCodingAgentOptions,
  spawnImpl: typeof spawn = spawn,
): Promise<CodingRunResult> {
  return new Promise((resolve, reject) => {
    const backend =
      opts.provider === "codex-cli" ? codexBackend(opts) : claudeBackend(opts);

    const proc = spawnImpl(backend.file, backend.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: backend.detached,
      ...(backend.env ? { env: backend.env } : {}),
    });

    let stderr = "";
    let sessionId = opts.resumeSessionId ?? opts.sessionId ?? "";
    let result: CodingRunResult | null = null;
    let settled = false;
    let aborted = false;
    let inactivityTimer: NodeJS.Timeout | null = null;

    const killTree = () => {
      if (backend.detached) {
        // Codex spawns real shells; killing the group takes them with it.
        killCodexTree(proc);
        return;
      }
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

    const parser = backend.createParser((event) => {
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
        // No terminal result: a failure, never a silently-empty success —
        // codex in particular can exit 0 with nothing useful on stdout.
        reject(
          new Error(
            `${backend.label} exited with code ${code} without a result: ${stderr.slice(-2000)}`,
          ),
        );
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        backend.invalidate();
        if (backend.notInstalled) {
          fail(new Error(backend.notInstalled));
          return;
        }
      }
      fail(err);
    });

    resetInactivity();
    proc.stdin.write(opts.prompt);
    proc.stdin.end();
  });
}
