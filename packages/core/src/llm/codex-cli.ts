import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CodingEvent } from "@skipper/shared";
import type { AgentOptions, LLMResponse, StructuredOptions } from "./provider";
import { AgentAbortError } from "./provider";
import { parseJsonReply } from "./json";
import { createCodexRunAccumulator } from "./codex-stream";
import { memoryServerConfig, type MemoryMcp } from "./memory-mcp";
import { graphifyServerConfig, type GraphifyMcp } from "./graphify-mcp";

/**
 * The codex-cli runtime's structured-call options (#239) — mirrors
 * ClaudeStructuredOptions so RuntimeStructuredOptions fits both. `sessionId`,
 * `tools` and `maxTurns` are accepted and ignored: a codex structured call is
 * always ephemeral and read-only, and codex has no turn budget flag.
 */
export interface CodexStructuredOptions extends StructuredOptions {
  cwd?: string;
  sessionId?: string;
  tools?: string;
  maxTurns?: number;
}

// Same resolution problem as claude on Windows: `spawn("codex")` can't execute
// an npm shim (codex.cmd / codex.ps1), and a shell would wreck arg quoting
// (-c developer_instructions=… carries free text). Prefer a native codex.exe;
// fall back to running the npm package's JS entry under our own runtime.
// R7 (#239): the Windows install layout is mirrored from claude and still
// unverified on a real Windows box.
export interface CodexCmd {
  file: string;
  argsPrefix: string[];
  env?: NodeJS.ProcessEnv;
}
let resolvedCodex: CodexCmd | null = null;

/** Reset the memoized resolution — codex may get installed mid-session. */
export function invalidateResolvedCodex(): void {
  resolvedCodex = null;
}

export function resolveCodex(): CodexCmd {
  if (resolvedCodex) return resolvedCodex;
  if (process.platform !== "win32") {
    return (resolvedCodex = { file: "codex", argsPrefix: [] });
  }
  const candidates: string[] = [];
  // Known locations first: a running app's PATH is stale after a fresh install
  // (Windows only updates NEW processes), so `where codex` alone misses it.
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || "";
  const local = process.env.LOCALAPPDATA || "";
  const known = [
    home && join(home, ".local", "bin", "codex.exe"),
    local && join(local, "Programs", "codex", "codex.exe"),
    appdata && join(appdata, "npm", "codex.cmd"),
    appdata && join(appdata, "npm", "codex.exe"),
  ].filter(Boolean) as string[];
  for (const k of known) if (existsSync(k)) candidates.push(k);
  try {
    execSync("where codex", { encoding: "utf-8", windowsHide: true })
      .split(/\r?\n/)
      .map((c) => c.trim())
      .filter(Boolean)
      .forEach((c) => candidates.push(c));
  } catch {
    /* nothing on PATH — the known locations above may still have matched */
  }
  const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
  if (exe) return (resolvedCodex = { file: exe, argsPrefix: [] });
  const shim = candidates.find((c) => /\.(cmd|bat|ps1)$/i.test(c)) ?? candidates[0];
  if (shim) {
    const cliJs = join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(cliJs)) {
      return (resolvedCodex = {
        file: process.execPath,
        argsPrefix: [cliJs],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    }
  }
  return (resolvedCodex = { file: "codex", argsPrefix: [] });
}

/**
 * Shape-compatible with ClaudeCliError (subtype + numTurns) so the salvage
 * probe can be generalized across runtimes under #240. The synthetic subtypes
 * are minted by our own guard timers; codex has no max-turns death (#239 D7).
 */
export class CodexCliError extends Error {
  constructor(
    message: string,
    readonly subtype?: string,
    readonly numTurns?: number,
  ) {
    super(message);
    this.name = "CodexCliError";
  }
}

const SIGKILL_ESCALATION_MS = 3_000;
const DEFAULT_AGENT_HARD_TIMEOUT_MS = 600_000;
const DEFAULT_AGENT_INACTIVITY_MS = 600_000;

function timeoutError(subtype: "error_hard_timeout" | "error_inactivity", ms: number): CodexCliError {
  const min = Math.max(1, Math.round(ms / 60_000));
  return new CodexCliError(
    subtype === "error_hard_timeout"
      ? `agent run hit the time budget (${min} min) — killed`
      : `agent produced no output for ${min} min — killed as hung`,
    subtype,
  );
}

/**
 * TOML-encode a `-c key=value` override value. codex parses the value portion
 * as TOML and falls back to a literal string when it doesn't parse, so a
 * JSON-encoded string (a valid TOML basic string) round-trips exactly.
 */
export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${k}=${tomlValue(v)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** The system prompt channel: codex has no --system-prompt, but
 *  `developer_instructions` is honoured as one (#239 D3). */
export function buildSystemPromptArgs(systemPrompt?: string): string[] {
  return systemPrompt ? ["-c", `developer_instructions=${tomlValue(systemPrompt)}`] : [];
}

export interface CodexConfigOptions {
  /** Inject the skipper-memory MCP server, scoped to the item's repo (#45). */
  memory?: MemoryMcp;
  /** Inject the graphify knowledge-graph MCP server, scoped to the item's repo
   *  (#233, wired here by #259). */
  graph?: GraphifyMcp;
  systemPrompt?: string;
}

/**
 * The flags every codex run shares. `--ignore-user-config` is the strict-MCP
 * equivalent — it drops the user's config.toml (and with it their MCP servers
 * and instructions) while auth still resolves from their CODEX_HOME. Skipper's
 * own settings ride in as `-c` overrides on top.
 */
export function codexConfigArgs(opts: CodexConfigOptions = {}): string[] {
  const args = [
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-c",
    "project_doc_max_bytes=0", // suppress the repo's AGENTS.md auto-load
  ];
  if (opts.memory) {
    const server = memoryServerConfig(opts.memory);
    args.push(
      "-c",
      `mcp_servers.skipper-memory.command=${tomlValue(server.command)}`,
      "-c",
      `mcp_servers.skipper-memory.args=${tomlValue(server.args)}`,
      "-c",
      `mcp_servers.skipper-memory.env=${tomlValue(server.env)}`,
    );
  }
  if (opts.graph) {
    const server = graphifyServerConfig(opts.graph);
    args.push(
      "-c",
      `mcp_servers.graphify.command=${tomlValue(server.command)}`,
      "-c",
      `mcp_servers.graphify.args=${tomlValue(server.args)}`,
    );
  }
  args.push(...buildSystemPromptArgs(opts.systemPrompt));
  return args;
}

export interface RunCodexOptions {
  cwd?: string;
  onStdout?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Wall-clock cap; on expiry kills the tree and rejects error_hard_timeout. */
  hardTimeoutMs?: number;
  /** No-stdout cap, re-armed per chunk; rejects error_inactivity. Armed only when set. */
  inactivityTimeoutMs?: number;
}

/** Spawn codex, guard it (abort + both timers), resolve its stdout. */
function runCodexProcess(
  args: string[],
  stdin?: string,
  opts: RunCodexOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // An already-aborted signal never fires the { once: true } listener (#159).
    if (opts.signal?.aborted) {
      reject(new AgentAbortError());
      return;
    }
    const codex = resolveCodex();
    const proc = spawn(codex.file, [...codex.argsPrefix, ...args], {
      cwd: opts.cwd ?? tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      ...(codex.env ? { env: codex.env } : {}),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let inactivityTimer: NodeJS.Timeout | null = null;

    const killTree = () => {
      proc.kill("SIGTERM");
      const escalate = setTimeout(() => proc.kill("SIGKILL"), SIGKILL_ESCALATION_MS);
      escalate.unref?.();
    };

    const cleanup = () => {
      clearTimeout(hardTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

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
        fail(new Error(`codex exited with code ${code}: ${stderr.slice(-2000)}`));
      } else {
        succeed(stdout);
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        invalidateResolvedCodex();
        fail(
          new Error(
            'Codex CLI is not installed or not in your PATH.\n\n' +
            'To fix this:\n' +
            '  1. Install Codex: npm install -g @openai/codex\n' +
            '  2. Authenticate: codex login\n' +
            '  3. Restart Skipper (on Windows, a fresh install only lands on the PATH of NEW processes)\n\n' +
            'Alternatively, pick a different runtime in Settings.',
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

/**
 * The read-leaning half of the codex-cli runtime (#239): an agentic completion
 * and a structured call, both sandboxed read-only. The write-capable coding run
 * lives in coder/codex-run.ts. Unlike claude, codex mints its own session id —
 * `opts.sessionId` is accepted and ignored, and the minted thread id comes back
 * on the response instead.
 */
export class CodexCli {
  constructor(private model?: string) {}

  private modelArgs(): string[] {
    return this.model ? ["--model", this.model] : [];
  }

  async agent(prompt: string, opts: AgentOptions = {}): Promise<LLMResponse> {
    // opts.maxTurns has no codex equivalent (#239 D7) and opts.confinement is
    // the claude rules machinery — the read-only sandbox below replaces it.
    const persist = Boolean(opts.sessionId || opts.resumeSessionId);
    const args = [
      "exec",
      ...(opts.resumeSessionId ? ["resume", opts.resumeSessionId] : []),
      "--json",
      ...this.modelArgs(),
      "--sandbox",
      "read-only",
      ...(opts.cwd ? ["-C", opts.cwd] : []),
      ...(persist ? [] : ["--ephemeral"]),
      ...codexConfigArgs({ memory: opts.memory, graph: opts.graph, systemPrompt: opts.systemPrompt }),
      "-",
    ];

    const accumulator = createCodexRunAccumulator((event: CodingEvent) => opts.onEvent?.(event));
    await runCodexProcess(args, prompt, {
      cwd: opts.cwd,
      signal: opts.signal,
      onStdout: (chunk) => accumulator.feed(chunk),
      hardTimeoutMs: opts.hardTimeoutMs ?? DEFAULT_AGENT_HARD_TIMEOUT_MS,
      inactivityTimeoutMs: opts.inactivityTimeoutMs ?? DEFAULT_AGENT_INACTIVITY_MS,
    });
    accumulator.flush();
    const outcome = accumulator.finish();
    if (outcome.failure) {
      throw new CodexCliError(`Codex CLI error: ${outcome.failure}`);
    }
    return {
      text: outcome.resultText ?? "",
      ...(outcome.event.usage ? { usage: outcome.event.usage } : {}),
      ...(persist ? { sessionId: outcome.sessionId ?? opts.resumeSessionId } : {}),
    };
  }

  async structured<T>(
    prompt: string,
    schema: Record<string, unknown>,
    opts: CodexStructuredOptions = {},
  ): Promise<T> {
    // Read-only sandbox is the honest analog of the claude path's read-leaning
    // toolset; --output-schema is a future improvement (#239 D4).
    const args = [
      "exec",
      "--json",
      ...this.modelArgs(),
      "--sandbox",
      "read-only",
      "--ephemeral",
      ...(opts.cwd ? ["-C", opts.cwd] : []),
      ...codexConfigArgs(),
      "-",
    ];
    const inlined =
      `${prompt}\n\n--\nReply with ONLY a single JSON value matching this JSON Schema. No prose, no code fences, no preamble.\n\nSchema:\n${JSON.stringify(schema)}`;

    const accumulator = createCodexRunAccumulator(() => {});
    await runCodexProcess(args, inlined, {
      cwd: opts.cwd,
      signal: opts.signal,
      onStdout: (chunk) => accumulator.feed(chunk),
    });
    accumulator.flush();
    const outcome = accumulator.finish();
    if (outcome.failure) {
      throw new CodexCliError(`Codex CLI error: ${outcome.failure}`);
    }
    return parseJsonReply<T>(outcome.resultText ?? "");
  }
}
