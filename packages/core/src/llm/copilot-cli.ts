import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CodingEvent } from "@skipper/shared";
import type { AgentOptions, LLMResponse, StructuredOptions } from "./provider";
import { AgentAbortError } from "./provider";
import { parseJsonReply } from "./json";
import { createCopilotRunAccumulator } from "./copilot-stream";
import { memoryServerConfig, type MemoryMcp } from "./memory-mcp";
import { graphifyServerConfig, type GraphifyMcp } from "./graphify-mcp";

/**
 * The copilot-cli runtime's structured-call options (#242) — mirrors
 * ClaudeStructuredOptions so RuntimeStructuredOptions fits both. `sessionId`,
 * `tools` and `maxTurns` are accepted and ignored: a copilot structured call is
 * always sessionless and read-leaning, and copilot has no turn budget flag.
 */
export interface CopilotStructuredOptions extends StructuredOptions {
  cwd?: string;
  sessionId?: string;
  tools?: string;
  maxTurns?: number;
}

// Same resolution problem as claude and codex on Windows: `spawn("copilot")`
// can't execute an npm shim (copilot.cmd / copilot.ps1), and a shell would wreck
// arg quoting. Prefer a native copilot.exe; fall back to running the npm
// package's JS entry under our own runtime.
// R4 (#242): the Windows install layout is mirrored from codex and still
// unverified on a real Windows box.
export interface CopilotCmd {
  file: string;
  argsPrefix: string[];
  env?: NodeJS.ProcessEnv;
}
let resolvedCopilot: CopilotCmd | null = null;

/** Reset the memoized resolution — copilot may get installed mid-session. */
export function invalidateResolvedCopilot(): void {
  resolvedCopilot = null;
}

export function resolveCopilot(): CopilotCmd {
  if (resolvedCopilot) return resolvedCopilot;
  if (process.platform !== "win32") {
    return (resolvedCopilot = { file: "copilot", argsPrefix: [] });
  }
  const candidates: string[] = [];
  // Known locations first: a running app's PATH is stale after a fresh install
  // (Windows only updates NEW processes), so `where copilot` alone misses it.
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || "";
  const local = process.env.LOCALAPPDATA || "";
  const known = [
    home && join(home, ".local", "bin", "copilot.exe"),
    local && join(local, "Programs", "copilot", "copilot.exe"),
    appdata && join(appdata, "npm", "copilot.cmd"),
    appdata && join(appdata, "npm", "copilot.exe"),
  ].filter(Boolean) as string[];
  for (const k of known) if (existsSync(k)) candidates.push(k);
  try {
    execSync("where copilot", { encoding: "utf-8", windowsHide: true })
      .split(/\r?\n/)
      .map((c) => c.trim())
      .filter(Boolean)
      .forEach((c) => candidates.push(c));
  } catch {
    /* nothing on PATH — the known locations above may still have matched */
  }
  const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
  if (exe) return (resolvedCopilot = { file: exe, argsPrefix: [] });
  const shim = candidates.find((c) => /\.(cmd|bat|ps1)$/i.test(c)) ?? candidates[0];
  if (shim) {
    const pkg = join(dirname(shim), "node_modules", "@github", "copilot");
    const entry = [join(pkg, "index.js"), join(pkg, "bin", "copilot.js")].find((c) =>
      existsSync(c),
    );
    if (entry) {
      return (resolvedCopilot = {
        file: process.execPath,
        argsPrefix: [entry],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    }
  }
  return (resolvedCopilot = { file: "copilot", argsPrefix: [] });
}

/**
 * Shape-compatible with ClaudeCliError (subtype + numTurns) so the salvage
 * probe can be generalized across runtimes. The synthetic subtypes are minted
 * by our own guard timers; copilot has no max-turns death (#242 D7).
 */
export class CopilotCliError extends Error {
  constructor(
    message: string,
    readonly subtype?: string,
    readonly numTurns?: number,
  ) {
    super(message);
    this.name = "CopilotCliError";
  }
}

const SIGKILL_ESCALATION_MS = 3_000;
const DEFAULT_AGENT_HARD_TIMEOUT_MS = 600_000;
const DEFAULT_AGENT_INACTIVITY_MS = 600_000;

function timeoutError(
  subtype: "error_hard_timeout" | "error_inactivity",
  ms: number,
): CopilotCliError {
  const min = Math.max(1, Math.round(ms / 60_000));
  return new CopilotCliError(
    subtype === "error_hard_timeout"
      ? `agent run hit the time budget (${min} min) — killed`
      : `agent produced no output for ${min} min — killed as hung`,
    subtype,
  );
}

/**
 * The flags every copilot run shares. `--no-custom-instructions` is the
 * double-injection guard: Skipper injects the seeded repo instructions itself,
 * so copilot must not also auto-load .github/copilot-instructions.md / AGENTS.md.
 */
export function copilotBaseArgs(): string[] {
  return ["--output-format", "json", "--no-ask-user", "--no-custom-instructions"];
}

/** The system prompt channel: copilot has no --system-prompt flag, so the
 *  system prompt rides as a prefix on the stdin-piped prompt (#242 D6). */
export function buildCopilotPrompt(systemPrompt: string | undefined, prompt: string): string {
  return systemPrompt ? `<system>\n${systemPrompt}\n</system>\n\n${prompt}` : prompt;
}

/** Copilot has no read-only mode, so the read-leaning paths deny the write side
 *  instead: agent() keeps shell (it inspects repos), structured() denies it too
 *  (#242 D5). The deny-tool kind names are unverified (R5). */
export function buildReadLeaningArgs(kind: "agent" | "structured"): string[] {
  const args = ["--deny-tool", "write"];
  if (kind === "structured") args.push("--deny-tool", "shell");
  return args;
}

/**
 * The Skipper MCP servers for a copilot run (#242 D3): skipper-memory (#45) and
 * the graphify knowledge graph (#233, wired by #259), each attached only when
 * the caller passes it. Copilot takes MCP servers as a file, not inline, so the
 * config is written to a throwaway temp dir the caller must clean up when the
 * process settles. `--additional-mcp-config` merges on top of the user's own
 * servers (`~/.copilot/mcp-config.json`, the repo's `.mcp.json`) — copilot has
 * no strict-MCP equivalent (copilot-cli#3380).
 */
export function buildCopilotMcpConfig(
  memory?: MemoryMcp,
  graph?: GraphifyMcp,
): {
  args: string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "skipper-copilot-"));
  const file = join(dir, "mcp.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        ...(memory
          ? { "skipper-memory": { type: "local", ...memoryServerConfig(memory), tools: ["*"] } }
          : {}),
        ...(graph
          ? { graphify: { type: "local", ...graphifyServerConfig(graph), tools: ["*"] } }
          : {}),
      },
    }),
  );
  return {
    args: ["--additional-mcp-config", file],
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing a run over */
      }
    },
  };
}

export interface RunCopilotOptions {
  cwd?: string;
  onStdout?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Wall-clock cap; on expiry kills the tree and rejects error_hard_timeout. */
  hardTimeoutMs?: number;
  /** No-stdout cap, re-armed per chunk; rejects error_inactivity. Armed only when set. */
  inactivityTimeoutMs?: number;
  /** Run once the process settles — releases the temp MCP config, if any. */
  onSettled?: () => void;
}

/** Spawn copilot, guard it (abort + both timers), resolve its stdout. */
function runCopilotProcess(
  args: string[],
  stdin?: string,
  opts: RunCopilotOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // An already-aborted signal never fires the { once: true } listener (#159).
    if (opts.signal?.aborted) {
      opts.onSettled?.();
      reject(new AgentAbortError());
      return;
    }
    const copilot = resolveCopilot();
    const proc = spawn(copilot.file, [...copilot.argsPrefix, ...args], {
      cwd: opts.cwd ?? tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      ...(copilot.env ? { env: copilot.env } : {}),
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
      opts.onSettled?.();
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
        fail(
          timeoutError("error_hard_timeout", opts.hardTimeoutMs ?? DEFAULT_AGENT_HARD_TIMEOUT_MS),
        );
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
        fail(new Error(`copilot exited with code ${code}: ${stderr.slice(-2000)}`));
      } else {
        succeed(stdout);
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        invalidateResolvedCopilot();
        fail(
          new Error(
            'GitHub Copilot CLI is not installed or not in your PATH.\n\n' +
            'To fix this:\n' +
            '  1. Install Copilot: npm install -g @github/copilot\n' +
            '  2. Authenticate: run `copilot` and use /login, or set COPILOT_GITHUB_TOKEN\n' +
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
 * The read-leaning half of the copilot-cli runtime (#242): an agentic completion
 * and a structured call, both denied the write tools. The write-capable coding
 * run lives in coder/copilot-run.ts. Copilot has no ephemeral-session flag, so
 * these runs leave session state in ~/.copilot/session-state — accepted (#242 D5).
 */
export class CopilotCli {
  constructor(private model?: string) {}

  private modelArgs(): string[] {
    return this.model ? ["--model", this.model] : [];
  }

  async agent(prompt: string, opts: AgentOptions = {}): Promise<LLMResponse> {
    // opts.maxTurns has no copilot equivalent (#242 D7) and opts.confinement is
    // the claude rules machinery — copilot's native path verification replaces
    // it.
    const persist = Boolean(opts.sessionId || opts.resumeSessionId);
    const mcp =
      opts.memory || opts.graph ? buildCopilotMcpConfig(opts.memory, opts.graph) : undefined;
    const args = [
      ...copilotBaseArgs(),
      ...this.modelArgs(),
      ...(opts.cwd ? ["-C", opts.cwd] : []),
      ...buildReadLeaningArgs("agent"),
      ...(opts.resumeSessionId
        ? ["--resume", opts.resumeSessionId]
        : opts.sessionId
          ? ["--session-id", opts.sessionId]
          : []),
      ...(mcp ? mcp.args : []),
    ];

    const accumulator = createCopilotRunAccumulator(
      (event: CodingEvent) => opts.onEvent?.(event),
      opts.sessionId ?? opts.resumeSessionId,
    );
    await runCopilotProcess(args, buildCopilotPrompt(opts.systemPrompt, prompt), {
      cwd: opts.cwd,
      signal: opts.signal,
      onStdout: (chunk) => accumulator.feed(chunk),
      hardTimeoutMs: opts.hardTimeoutMs ?? DEFAULT_AGENT_HARD_TIMEOUT_MS,
      inactivityTimeoutMs: opts.inactivityTimeoutMs ?? DEFAULT_AGENT_INACTIVITY_MS,
      ...(mcp ? { onSettled: mcp.cleanup } : {}),
    });
    accumulator.flush();
    const outcome = accumulator.finish();
    if (outcome.failure) {
      throw new CopilotCliError(`Copilot CLI error: ${outcome.failure}`);
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
    opts: CopilotStructuredOptions = {},
  ): Promise<T> {
    const args = [
      ...copilotBaseArgs(),
      ...this.modelArgs(),
      ...(opts.cwd ? ["-C", opts.cwd] : []),
      ...buildReadLeaningArgs("structured"),
    ];
    const inlined =
      `${prompt}\n\n--\nReply with ONLY a single JSON value matching this JSON Schema. No prose, no code fences, no preamble.\n\nSchema:\n${JSON.stringify(schema)}`;

    const accumulator = createCopilotRunAccumulator(() => {});
    await runCopilotProcess(args, inlined, {
      cwd: opts.cwd,
      signal: opts.signal,
      onStdout: (chunk) => accumulator.feed(chunk),
    });
    accumulator.flush();
    const outcome = accumulator.finish();
    if (outcome.failure) {
      throw new CopilotCliError(`Copilot CLI error: ${outcome.failure}`);
    }
    return parseJsonReply<T>(outcome.resultText ?? "");
  }
}
