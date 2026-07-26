import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import type { CodingEvent } from "@skipper/shared";
import type { AgentOptions, LLMResponse, StructuredOptions } from "./provider";
import { AgentAbortError } from "./provider";
import { parseJsonReply } from "./json";
import { createGeminiRunAccumulator } from "./gemini-stream";
import { memoryServerConfig, type MemoryMcp } from "./memory-mcp";

/**
 * The gemini-cli runtime's structured-call options (#243) — mirrors
 * ClaudeStructuredOptions so RuntimeStructuredOptions fits both. `sessionId`,
 * `tools` and `maxTurns` are accepted and ignored: a gemini structured call is
 * always sessionless and read-leaning, and gemini's only turn budget
 * (`model.maxSessionTurns`) is cumulative per session, not per run.
 */
export interface GeminiStructuredOptions extends StructuredOptions {
  cwd?: string;
  sessionId?: string;
  tools?: string;
  maxTurns?: number;
}

// Same resolution problem as claude, codex and copilot on Windows:
// `spawn("gemini")` can't execute an npm shim (gemini.cmd / gemini.ps1), and a
// shell would wreck arg quoting. Prefer a native gemini.exe; fall back to running
// the npm package's JS entry under our own runtime.
// The Windows install layout is mirrored from copilot and still unverified on a
// real Windows box (#243).
export interface GeminiCmd {
  file: string;
  argsPrefix: string[];
  env?: NodeJS.ProcessEnv;
}
let resolvedGemini: GeminiCmd | null = null;

/** Reset the memoized resolution — gemini may get installed mid-session. */
export function invalidateResolvedGemini(): void {
  resolvedGemini = null;
}

export function resolveGemini(): GeminiCmd {
  if (resolvedGemini) return resolvedGemini;
  if (process.platform !== "win32") {
    return (resolvedGemini = { file: "gemini", argsPrefix: [] });
  }
  const candidates: string[] = [];
  // Known locations first: a running app's PATH is stale after a fresh install
  // (Windows only updates NEW processes), so `where gemini` alone misses it.
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || "";
  const local = process.env.LOCALAPPDATA || "";
  const known = [
    home && join(home, ".local", "bin", "gemini.exe"),
    local && join(local, "Programs", "gemini", "gemini.exe"),
    appdata && join(appdata, "npm", "gemini.cmd"),
    appdata && join(appdata, "npm", "gemini.exe"),
  ].filter(Boolean) as string[];
  for (const k of known) if (existsSync(k)) candidates.push(k);
  try {
    execSync("where gemini", { encoding: "utf-8", windowsHide: true })
      .split(/\r?\n/)
      .map((c) => c.trim())
      .filter(Boolean)
      .forEach((c) => candidates.push(c));
  } catch {
    /* nothing on PATH — the known locations above may still have matched */
  }
  const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
  if (exe) return (resolvedGemini = { file: exe, argsPrefix: [] });
  const shim = candidates.find((c) => /\.(cmd|bat|ps1)$/i.test(c)) ?? candidates[0];
  if (shim) {
    const pkg = join(dirname(shim), "node_modules", "@google", "gemini-cli");
    const entry = [join(pkg, "dist", "index.js"), join(pkg, "bundle", "gemini.js")].find((c) =>
      existsSync(c),
    );
    if (entry) {
      return (resolvedGemini = {
        file: process.execPath,
        argsPrefix: [entry],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    }
  }
  return (resolvedGemini = { file: "gemini", argsPrefix: [] });
}

/**
 * Shape-compatible with ClaudeCliError (subtype + numTurns) so the salvage probe
 * can be generalized across runtimes. The synthetic subtypes are minted by our
 * own guard timers; gemini's exit 53 (turn limit) is a user-level setting that
 * maps to error_max_turns if it ever fires (#243 D7).
 */
export class GeminiCliError extends Error {
  constructor(
    message: string,
    readonly subtype?: string,
    readonly numTurns?: number,
  ) {
    super(message);
    this.name = "GeminiCliError";
  }
}

const SIGKILL_ESCALATION_MS = 3_000;
const DEFAULT_AGENT_HARD_TIMEOUT_MS = 600_000;
const DEFAULT_AGENT_INACTIVITY_MS = 600_000;
/** Turn-limit exit code — the only gemini exit worth a typed subtype (#243 D7). */
const TURN_LIMIT_EXIT_CODE = 53;
/** A context file name no repo has, which is how gemini's GEMINI.md auto-load is
 *  suppressed: there is no flag for it, only `context.fileName` (#243). */
const NO_CONTEXT_FILE = "SKIPPER_NO_CONTEXT.md";

function timeoutError(
  subtype: "error_hard_timeout" | "error_inactivity",
  ms: number,
): GeminiCliError {
  const min = Math.max(1, Math.round(ms / 60_000));
  return new GeminiCliError(
    subtype === "error_hard_timeout"
      ? `agent run hit the time budget (${min} min) — killed`
      : `agent produced no output for ${min} min — killed as hung`,
    subtype,
  );
}

/** The flags every gemini run shares. `--skip-trust` clears the folder-trust
 *  prompt a fresh worktree would otherwise hit in headless mode (#243). */
export function geminiBaseArgs(): string[] {
  return ["--output-format", "stream-json", "--skip-trust"];
}

/** The system prompt channel: GEMINI_SYSTEM_MD replaces the built-in prompt whole
 *  (tool instructions included), so the system prompt rides as a prefix on the
 *  stdin-piped prompt instead (#243 D6). */
export function buildGeminiPrompt(systemPrompt: string | undefined, prompt: string): string {
  return systemPrompt ? `<system>\n${systemPrompt}\n</system>\n\n${prompt}` : prompt;
}

/** The repo's `info/exclude`, following a linked worktree's gitdir pointer to the
 *  common dir. Pure fs so no git process is spawned mid-run. */
function gitInfoExclude(cwd: string): string | undefined {
  const dotGit = join(cwd, ".git");
  let isFile: boolean;
  try {
    isFile = statSync(dotGit).isFile();
  } catch {
    return undefined;
  }
  let gitDir = dotGit;
  if (isFile) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf-8"));
    if (!pointer) return undefined;
    const target = pointer[1].trim();
    gitDir = isAbsolute(target) ? target : resolvePath(cwd, target);
    try {
      const common = readFileSync(join(gitDir, "commondir"), "utf-8").trim();
      gitDir = isAbsolute(common) ? common : resolvePath(gitDir, common);
    } catch {
      /* not a linked worktree — the gitdir pointer is the common dir */
    }
  }
  return join(gitDir, "info", "exclude");
}

/** Keep the settings file Skipper drops in the worktree out of any commit the
 *  coder makes. The entry is repo-wide and benign, so it is never removed. */
function excludeGeminiDir(cwd: string): void {
  const file = gitInfoExclude(cwd);
  if (!file) return;
  try {
    let current = "";
    try {
      current = readFileSync(file, "utf-8");
    } catch {
      /* no exclude file yet — it is created below */
    }
    if (current.split(/\r?\n/).some((l) => l.trim() === ".gemini/")) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, current && !current.endsWith("\n") ? `${current}\n.gemini/\n` : `${current}.gemini/\n`);
  } catch {
    /* a missing exclude entry is not worth failing a run over */
  }
}

/**
 * Gemini's project settings file for one run (#243 D5). It is the only channel
 * for two things gemini has no flag for: suppressing the GEMINI.md context load
 * (Skipper injects the seeded repo instructions itself) and attaching the
 * skipper-memory MCP server (#45), which needs `trust: true` because a headless
 * run auto-denies every tool confirmation.
 *
 * The file lives in the run's own cwd, so an existing one is backed up and
 * restored by `cleanup`, which the caller must run on every exit path — settle
 * and kill alike. `--allowed-mcp-server-names` isolates the run from the user's
 * own configured servers; with no memory server the name matches nothing on
 * purpose, so none load.
 */
export function buildGeminiProjectSettings(
  cwd: string,
  memory?: MemoryMcp,
): { args: string[]; cleanup: () => void } {
  const dir = join(cwd, ".gemini");
  const file = join(dir, "settings.json");
  const createdDir = !existsSync(dir);
  if (createdDir) mkdirSync(dir, { recursive: true });
  const backup = existsSync(file) ? readFileSync(file, "utf-8") : undefined;
  writeFileSync(
    file,
    JSON.stringify(
      {
        context: { fileName: NO_CONTEXT_FILE },
        ...(memory
          ? {
              mcpServers: {
                "skipper-memory": { ...memoryServerConfig(memory), trust: true },
              },
            }
          : {}),
      },
      null,
      2,
    ),
  );
  excludeGeminiDir(cwd);
  return {
    args: ["--allowed-mcp-server-names", memory ? "skipper-memory" : "skipper-none"],
    cleanup: () => {
      try {
        if (backup !== undefined) {
          writeFileSync(file, backup);
          return;
        }
        rmSync(file, { force: true });
        if (createdDir) rmdirSync(dir);
      } catch {
        /* a leftover settings file is not worth failing a run over */
      }
    },
  };
}

/** Session identity: premint via --session-id, or resume an existing session.
 *  The two flags are mutually exclusive (#243 D10). */
export function geminiSessionArgs(sessionId?: string, resumeSessionId?: string): string[] {
  if (resumeSessionId) return ["--resume", resumeSessionId];
  if (sessionId) return ["--session-id", sessionId];
  return [];
}

export interface RunGeminiOptions {
  cwd?: string;
  onStdout?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Wall-clock cap; on expiry kills the tree and rejects error_hard_timeout. */
  hardTimeoutMs?: number;
  /** No-stdout cap, re-armed per chunk; rejects error_inactivity. Armed only when set. */
  inactivityTimeoutMs?: number;
  /** Run once the process settles — releases the project settings file, if any. */
  onSettled?: () => void;
}

/** Spawn gemini, guard it (abort + both timers), resolve its stdout. */
function runGeminiProcess(
  args: string[],
  stdin?: string,
  opts: RunGeminiOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // An already-aborted signal never fires the { once: true } listener (#159).
    if (opts.signal?.aborted) {
      opts.onSettled?.();
      reject(new AgentAbortError());
      return;
    }
    const gemini = resolveGemini();
    const proc = spawn(gemini.file, [...gemini.argsPrefix, ...args], {
      cwd: opts.cwd ?? tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      ...(gemini.env ? { env: gemini.env } : {}),
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
      } else if (code === TURN_LIMIT_EXIT_CODE && !stdout) {
        fail(new GeminiCliError("gemini hit its session turn limit", "error_max_turns"));
      } else if (code !== 0 && !stdout) {
        fail(new Error(`gemini exited with code ${code}: ${stderr.slice(-2000)}`));
      } else {
        succeed(stdout);
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        invalidateResolvedGemini();
        fail(
          new Error(
            'Gemini CLI is not installed or not in your PATH.\n\n' +
            'To fix this:\n' +
            '  1. Install Gemini: npm install -g @google/gemini-cli\n' +
            '  2. Authenticate: run `gemini` and sign in, or set GEMINI_API_KEY\n' +
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
 * The read-leaning half of the gemini-cli runtime (#243): an agentic completion
 * and a structured call, both on `--approval-mode=default`. Gemini has no
 * read-only mode, but a headless run auto-denies every tool that would prompt,
 * which turns default mode into exactly that restriction: the write and shell
 * tools come back denied and the model routes around them (#243 D9). The
 * write-capable coding run lives in coder/gemini-run.ts.
 *
 * With no cwd there is no project settings file, so a bare call still picks up
 * the user's global ~/.gemini context and MCP servers — documented, not
 * prevented (#243 D5). Sessions are keyed by cwd hash and gemini has no
 * ephemeral-session flag, so these runs leave state in ~/.gemini/tmp.
 */
export class GeminiCli {
  constructor(private model?: string) {}

  private modelArgs(): string[] {
    return this.model ? ["-m", this.model] : [];
  }

  async agent(prompt: string, opts: AgentOptions = {}): Promise<LLMResponse> {
    // opts.maxTurns has no per-run gemini equivalent (#243 D7) and
    // opts.confinement is the claude rules machinery — gemini's approval mode
    // replaces it. opts.graph (graphify) is claude-only for now.
    const persist = Boolean(opts.sessionId || opts.resumeSessionId);
    const settings = opts.cwd ? buildGeminiProjectSettings(opts.cwd, opts.memory) : undefined;
    const args = [
      ...geminiBaseArgs(),
      ...this.modelArgs(),
      "--approval-mode=default",
      ...geminiSessionArgs(opts.sessionId, opts.resumeSessionId),
      ...(settings ? settings.args : []),
    ];

    const accumulator = createGeminiRunAccumulator(
      (event: CodingEvent) => opts.onEvent?.(event),
      opts.sessionId ?? opts.resumeSessionId,
    );
    await runGeminiProcess(args, buildGeminiPrompt(opts.systemPrompt, prompt), {
      cwd: opts.cwd,
      signal: opts.signal,
      onStdout: (chunk) => accumulator.feed(chunk),
      hardTimeoutMs: opts.hardTimeoutMs ?? DEFAULT_AGENT_HARD_TIMEOUT_MS,
      inactivityTimeoutMs: opts.inactivityTimeoutMs ?? DEFAULT_AGENT_INACTIVITY_MS,
      ...(settings ? { onSettled: settings.cleanup } : {}),
    });
    accumulator.flush();
    const outcome = accumulator.finish();
    if (outcome.failure) {
      throw new GeminiCliError(`Gemini CLI error: ${outcome.failure}`);
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
    opts: GeminiStructuredOptions = {},
  ): Promise<T> {
    const settings = opts.cwd ? buildGeminiProjectSettings(opts.cwd) : undefined;
    const args = [
      ...geminiBaseArgs(),
      ...this.modelArgs(),
      "--approval-mode=default",
      ...(settings ? settings.args : []),
    ];
    const inlined =
      `${prompt}\n\n--\nReply with ONLY a single JSON value matching this JSON Schema. No prose, no code fences, no preamble.\n\nSchema:\n${JSON.stringify(schema)}`;

    const accumulator = createGeminiRunAccumulator(() => {});
    await runGeminiProcess(args, inlined, {
      cwd: opts.cwd,
      signal: opts.signal,
      onStdout: (chunk) => accumulator.feed(chunk),
      ...(settings ? { onSettled: settings.cleanup } : {}),
    });
    accumulator.flush();
    const outcome = accumulator.finish();
    if (outcome.failure) {
      throw new GeminiCliError(`Gemini CLI error: ${outcome.failure}`);
    }
    return parseJsonReply<T>(outcome.resultText ?? "");
  }
}
