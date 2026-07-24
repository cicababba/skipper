import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentOptions,
  LLMProviderInterface,
  LLMResponse,
  StructuredOptions,
} from "./provider";
import { AgentAbortError } from "./provider";

/**
 * The claude-cli provider's structured-call options (#238): the wide fields
 * (session persistence, cwd, multi-turn tool use) the narrowed StructuredOptions
 * dropped. Reached via the runtime's structured() call, not the plain provider
 * interface — those extras only mean something to the CLI.
 */
export interface ClaudeStructuredOptions extends StructuredOptions {
  /** Working directory the structured call runs in (so the on-disk session lands there). */
  cwd?: string;
  /** Persist under this session id (drops --no-session-persistence). */
  sessionId?: string;
  /** Comma-separated CLI tool list; enables multi-turn tool use for this call
   *  (the reply is still the final JSON). */
  tools?: string;
  /** Turn budget when tools are enabled. */
  maxTurns?: number;
}
import { parseJsonReply } from "./json";
import { createStreamJsonParser } from "./stream";
import { MEMORY_TOOLS } from "./memory-mcp";
import { GRAPHIFY_TOOLS } from "./graphify-mcp";
import { buildMcpConfigArgs } from "./mcp-config";
import {
  buildConfinementSettingsArgs,
  confinementEnv,
  type RunConfinement,
} from "./confinement";

// On Windows, `spawn("claude")` can't execute the npm shim (claude.cmd /
// claude.ps1): Node refuses .cmd files without a shell, and a shell would
// wreck arg quoting (--system-prompt carries free text). Resolve the real
// target once: a native claude.exe spawns directly; an npm shim is bypassed
// by running its cli.js under our own runtime (ELECTRON_RUN_AS_NODE inside
// the packaged app, plain node otherwise).
export interface ClaudeCmd {
  file: string;
  argsPrefix: string[];
  env?: NodeJS.ProcessEnv;
}
let resolvedClaude: ClaudeCmd | null = null;

/** Reset the memoized resolution — claude may get installed mid-session. */
export function invalidateResolvedClaude(): void {
  resolvedClaude = null;
}

export function resolveClaude(): ClaudeCmd {
  if (resolvedClaude) return resolvedClaude;
  if (process.platform !== "win32") {
    return (resolvedClaude = { file: "claude", argsPrefix: [] });
  }
  const candidates: string[] = [];
  // Known install locations checked DIRECTLY first — a running app's PATH is
  // stale after a fresh install (Windows only updates NEW processes), so
  // `where claude` alone misses a just-installed claude. Native installer
  // (claude.ai/install.cmd) → %USERPROFILE%\.local\bin\claude.exe; npm -g →
  // %APPDATA%\npm\claude.cmd. Prefer the native .exe (spawns directly).
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || "";
  const local = process.env.LOCALAPPDATA || "";
  const known = [
    home && join(home, ".local", "bin", "claude.exe"),
    local && join(local, "Programs", "claude", "claude.exe"),
    appdata && join(appdata, "npm", "claude.cmd"),
    appdata && join(appdata, "npm", "claude.exe"),
  ].filter(Boolean) as string[];
  for (const k of known) if (existsSync(k)) candidates.push(k);
  try {
    execSync("where claude", { encoding: "utf-8", windowsHide: true })
      .split(/\r?\n/)
      .map((c) => c.trim())
      .filter(Boolean)
      .forEach((c) => candidates.push(c));
  } catch {
    /* nothing on PATH — the known locations above may still have matched */
  }
  const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
  if (exe) return (resolvedClaude = { file: exe, argsPrefix: [] });
  const shim = candidates.find((c) => /\.(cmd|bat|ps1)$/i.test(c)) ?? candidates[0];
  if (shim) {
    const cliJs = join(dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(cliJs)) {
      return (resolvedClaude = {
        file: process.execPath,
        argsPrefix: [cliJs],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    }
  }
  return (resolvedClaude = { file: "claude", argsPrefix: [] });
}

// The CLI's result event carries `result` on success and on most failures, but
// a max-turns death sets is_error with no result field — so `${data.result}`
// renders "undefined". Derive a message from the subtype instead.
export function cliErrorMessage(data: Record<string, unknown>): string {
  if (typeof data.result === "string" && data.result.length > 0) {
    return `Claude CLI error: ${data.result}`;
  }
  if (data.subtype === "error_max_turns") {
    const turns = typeof data.num_turns === "number" ? ` after ${data.num_turns} turns` : "";
    return `Claude CLI error: agent hit the max-turns limit${turns}`;
  }
  return `Claude CLI error: ${typeof data.subtype === "string" ? data.subtype : "unknown failure"}`;
}

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly subtype?: string,
    readonly numTurns?: number,
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

function claudeCliError(data: Record<string, unknown>): ClaudeCliError {
  return new ClaudeCliError(
    cliErrorMessage(data),
    typeof data.subtype === "string" ? data.subtype : undefined,
    typeof data.num_turns === "number" ? data.num_turns : undefined,
  );
}

const SIGKILL_ESCALATION_MS = 3_000;

/** Wall-clock cap when a caller passes no budget — preserves the old 10-min ceiling. */
const DEFAULT_AGENT_HARD_TIMEOUT_MS = 600_000;
/** Inactivity cap for the streaming agent path (json output buffers to the end,
 *  so the non-streaming branch never arms this). */
const DEFAULT_AGENT_INACTIVITY_MS = 10 * 60_000;

/**
 * True for the deaths whose on-disk session can be resumed for a wrap-up salvage
 * run (#194): a max-turns death (CLI-native) and our two synthetic guard kills.
 * An AgentAbortError is never a ClaudeCliError, so a cancelled run is never salvaged.
 */
export function isSalvageableDeath(err: unknown): boolean {
  return (
    err instanceof ClaudeCliError &&
    (err.subtype === "error_max_turns" ||
      err.subtype === "error_hard_timeout" ||
      err.subtype === "error_inactivity")
  );
}

// The two synthetic subtypes below are minted only by our own guard timers; the
// CLI never emits them. They join error_max_turns as salvageable deaths (#194).
function timeoutError(
  subtype: "error_hard_timeout" | "error_inactivity",
  ms: number,
): ClaudeCliError {
  const min = Math.max(1, Math.round(ms / 60_000));
  return new ClaudeCliError(
    subtype === "error_hard_timeout"
      ? `agent run hit the time budget (${min} min) — killed`
      : `agent produced no output for ${min} min — killed as hung`,
    subtype,
  );
}

interface RunClaudeOptions {
  cwd?: string;
  onStdout?: (chunk: string) => void;
  signal?: AbortSignal;
  confinement?: RunConfinement;
  /** Wall-clock cap; on expiry kills the tree and rejects error_hard_timeout. */
  hardTimeoutMs?: number;
  /** No-stdout cap, re-armed per chunk; rejects error_inactivity. Armed only when set. */
  inactivityTimeoutMs?: number;
}

function runClaude(args: string[], stdin?: string, opts: RunClaudeOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // An already-aborted signal never fires the { once: true } listener, so the
    // process would run to completion — bail before spawning (#159).
    if (opts.signal?.aborted) {
      reject(new AgentAbortError());
      return;
    }
    const claude = resolveClaude();
    // A confined run (#196) needs ELECTRON_RUN_AS_NODE in the claude env so the
    // guard hook (process.execPath as node) inherits it; harmless otherwise.
    const env = confinementEnv(opts.confinement, claude.env);
    const proc = spawn(claude.file, [...claude.argsPrefix, ...args], {
      cwd: opts.cwd ?? tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let inactivityTimer: NodeJS.Timeout | null = null;

    const killTree = () => {
      proc.kill("SIGTERM");
      // Bash-tool grandchildren linger past SIGTERM — escalate (idiom from coder/run.ts).
      const escalate = setTimeout(() => proc.kill("SIGKILL"), SIGKILL_ESCALATION_MS);
      escalate.unref?.();
    };

    const cleanup = () => {
      clearTimeout(hardTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    // settled guards against a guard kill and the later `close` double-settling;
    // whichever fires first wins, and abort always clears the timers so a timer
    // can never settle after an abort.
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onAbort = () => {
      aborted = true;
      fail(new AgentAbortError());
      killTree();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const resetInactivity = () => {
      if (opts.inactivityTimeoutMs === undefined) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fail(timeoutError("error_inactivity", opts.inactivityTimeoutMs!));
        killTree();
      }, opts.inactivityTimeoutMs);
    };

    const hardTimer = setTimeout(
      () => {
        fail(timeoutError("error_hard_timeout", opts.hardTimeoutMs ?? DEFAULT_AGENT_HARD_TIMEOUT_MS));
        killTree();
      },
      opts.hardTimeoutMs ?? DEFAULT_AGENT_HARD_TIMEOUT_MS,
    );

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      resetInactivity();
      opts.onStdout?.(text);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (aborted) {
        fail(new AgentAbortError());
      } else if (code !== 0 && !stdout) {
        fail(new Error(`claude exited with code ${code}: ${stderr}`));
      } else {
        succeed(stdout);
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolvedClaude = null; // re-resolve next time — claude may get installed mid-session
        fail(
          new Error(
            'Claude CLI is not installed or not in your PATH.\n\n' +
            'To fix this:\n' +
            '  1. Install Claude Code: npm install -g @anthropic-ai/claude-code\n' +
            '  2. Authenticate: claude auth login\n' +
            '  3. Restart Skipper (on Windows, a fresh install only lands on the PATH of NEW processes)\n\n' +
            'Alternatively, pick a different provider in Settings.',
          ),
        );
      } else {
        fail(err);
      }
    });

    resetInactivity();
    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

export class ClaudeCLIProvider implements LLMProviderInterface {
  readonly name = "claude-cli" as const;

  constructor(
    private model: string = "sonnet",
    private maxTurns: number = 5,
  ) {}

  async ask(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    // Pass prompt via stdin to avoid argument length limits
    const args = [
      "-p",
      "-",
      "--output-format",
      "json",
      "--model",
      this.model,
      "--max-turns",
      "1",
      "--no-session-persistence",
      // We want a single-turn text completion — no tool calls. Without
      // these the user's global ~/.claude (skills, agents, settings) leaks
      // in and the CLI tries to use Bash/Read on startup (e.g. orphan-
      // session checks from a project's CLAUDE.md), burning the single
      // turn before we get an answer.
      "--disable-slash-commands",
      "--tools",
      "",
      "--setting-sources",
      "",
    ];

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const stdout = await runClaude(args, prompt);

    const data = JSON.parse(stdout);

    if (data.is_error) {
      throw claudeCliError(data);
    }

    return {
      text: data.result ?? "",
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens ?? 0,
            outputTokens: data.usage.output_tokens ?? 0,
          }
        : undefined,
    };
  }

  /**
   * Agentic completion. Unlike `ask`, this lets the CLI use tools across
   * multiple turns — so the model can read the user's local projects, search
   * and fetch the web, or run commands to verify facts before answering.
   * Used by the wiki AI-edit flow ("analyze this project and fix the page").
   */
  async agent(prompt: string, opts: AgentOptions = {}): Promise<LLMResponse> {
    // Solutions-memory MCP is opt-in (#45): the planner passes opts.memory, the
    // reviewer / wiki-edit callers don't — so their tool surface is unchanged.
    const baseTools = "Read,Grep,Glob,WebFetch,WebSearch,Bash";
    const tools = [
      baseTools,
      ...(opts.memory ? [MEMORY_TOOLS] : []),
      ...(opts.graph ? [GRAPHIFY_TOOLS] : []),
    ].join(",");
    const args = [
      "-p",
      "-",
      "--output-format",
      opts.onEvent ? "stream-json" : "json",
      ...(opts.onEvent ? ["--verbose"] : []), // stream-json requires it in print mode
      "--model",
      this.model,
      "--max-turns",
      String(opts.maxTurns ?? 24),
      ...(opts.resumeSessionId
        ? ["--resume", opts.resumeSessionId]
        : opts.sessionId
          ? ["--session-id", opts.sessionId]
          : ["--no-session-persistence"]),
      "--disable-slash-commands",
      // Enable a capable but read-leaning toolset so the agent can inspect
      // local code and the web. `--tools` limits what's available (no
      // Edit/Write — we persist the result ourselves), and `--allowedTools`
      // pre-approves them so they run without a prompt in headless (-p) mode,
      // where an approval request would otherwise be auto-denied. Keep
      // --setting-sources empty so the user's global skills / project
      // CLAUDE.md don't hijack the run.
      "--tools",
      tools,
      "--allowedTools",
      tools,
      "--setting-sources",
      "",
      ...buildMcpConfigArgs(opts.memory, opts.graph),
      ...(opts.confinement ? buildConfinementSettingsArgs(opts.confinement) : []),
    ];

    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    if (opts.onEvent) {
      return this.agentStreaming(args, prompt, opts);
    }

    const stdout = await runClaude(args, prompt, {
      cwd: opts.cwd,
      signal: opts.signal,
      confinement: opts.confinement,
      // No inactivity guard: --output-format json buffers the whole reply until
      // the end, so a healthy run is silent for its entire duration (#194).
      hardTimeoutMs: opts.hardTimeoutMs ?? DEFAULT_AGENT_HARD_TIMEOUT_MS,
    });
    const data = JSON.parse(stdout);
    if (data.is_error) {
      throw claudeCliError(data);
    }
    return {
      text: data.result ?? "",
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens ?? 0,
            outputTokens: data.usage.output_tokens ?? 0,
          }
        : undefined,
      ...(opts.sessionId || opts.resumeSessionId
        ? {
            sessionId:
              typeof data.session_id === "string"
                ? data.session_id
                : opts.sessionId ?? opts.resumeSessionId,
          }
        : {}),
    };
  }

  private async agentStreaming(
    args: string[],
    prompt: string,
    opts: AgentOptions,
  ): Promise<LLMResponse> {
    // The mapped result event truncates its summary — recover the full result
    // text (the plan JSON can exceed the cap) from the raw line instead.
    let resultLine: Record<string, unknown> | null = null;
    let initSessionId: string | undefined;
    const parser = createStreamJsonParser(
      (event) => {
        if (event.kind === "agent-init") initSessionId = event.sessionId;
        opts.onEvent?.(event);
      },
      (line) => {
        if (line.type === "result") resultLine = line;
      },
    );
    await runClaude(args, prompt, {
      cwd: opts.cwd,
      onStdout: (chunk) => parser.feed(chunk),
      signal: opts.signal,
      confinement: opts.confinement,
      hardTimeoutMs: opts.hardTimeoutMs ?? DEFAULT_AGENT_HARD_TIMEOUT_MS,
      inactivityTimeoutMs: opts.inactivityTimeoutMs ?? DEFAULT_AGENT_INACTIVITY_MS,
    });
    parser.flush();
    const data = resultLine as Record<string, unknown> | null;
    if (!data) {
      throw new Error("Claude CLI stream ended without a result");
    }
    if (data.is_error) {
      throw claudeCliError(data);
    }
    const usage = data.usage as Record<string, unknown> | undefined;
    return {
      text: typeof data.result === "string" ? data.result : "",
      usage: usage
        ? {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
          }
        : undefined,
      ...(opts.sessionId || opts.resumeSessionId
        ? { sessionId: initSessionId ?? opts.sessionId ?? opts.resumeSessionId }
        : {}),
    };
  }

  async askStructured<T>(
    prompt: string,
    schema: Record<string, unknown>,
    opts?: ClaudeStructuredOptions,
  ): Promise<T> {
    const toolsEnabled = typeof opts?.tools === "string" && opts.tools.length > 0;
    const args = [
      "-p",
      "-",
      "--output-format",
      "json",
      "--model",
      this.model,
      "--max-turns",
      toolsEnabled ? String(opts?.maxTurns ?? 8) : "1",
      ...(opts?.sessionId ? ["--session-id", opts.sessionId] : ["--no-session-persistence"]),
      "--disable-slash-commands",
      ...(toolsEnabled
        ? ["--tools", opts!.tools!, "--allowedTools", opts!.tools!]
        : ["--tools", ""]),
      "--setting-sources",
      "",
    ];

    // --json-schema in the current Claude CLI is a soft hint that triggers
    // tool-use mode (StructuredOutput tool), which doesn't compose well with
    // --tools "". We instead inline the schema in the prompt and require the
    // model to reply with JSON-only — then extract.
    const inlined =
      `${prompt}\n\n--\nReply with ONLY a single JSON value matching this JSON Schema. No prose, no code fences, no preamble.\n\nSchema:\n${JSON.stringify(schema)}`;
    const stdout = await runClaude(args, inlined, { cwd: opts?.cwd, signal: opts?.signal });

    const data = JSON.parse(stdout);
    if (data.is_error) {
      throw claudeCliError(data);
    }

    return parseJsonReply<T>(data.result ?? "");
  }
}
