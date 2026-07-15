import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CodingEvent } from "@skipper/shared";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "./provider";
import { parseJsonReply } from "./json";
import { createCodexStreamParser } from "./stream-codex";

/** Codex resolves its default model from a remote list (cached 300s) — an
 *  unpinned run can shift under us with no release on our side. Pin it. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const SIGKILL_ESCALATION_MS = 3_000;

/**
 * Flags every codex invocation carries.
 *
 * `--json` is non-negotiable: plain stdout interleaves unrelated session
 * traces undelimited, and duplicates the message onto stderr when stdout is
 * not a TTY. `--ignore-user-config` + `project_doc_max_bytes=0` are the
 * `--setting-sources ""` equivalent on the claude path — they stop the user's
 * ~/.codex/config.toml and the target repo's AGENTS.md from hijacking an
 * orchestration run.
 */
const BASE_FLAGS = ["--json", "--ignore-user-config", "-c", "project_doc_max_bytes=0"];

// Mirrors the claude path's shim problem, but only on one install route: brew,
// curl and install.ps1 all drop a native binary, while `npm i -g @openai/codex`
// lays down a Node shim that Node itself refuses to spawn without a shell.
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
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || "";
  const local = process.env.LOCALAPPDATA || "";
  const known = [
    home && join(home, ".codex", "bin", "codex.exe"),
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

/** Killing codex does not kill the shells it spawned — take out the group. */
export function killCodexTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { windowsHide: true });
    } catch {
      proc.kill("SIGKILL");
    }
    return;
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-proc.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, SIGKILL_ESCALATION_MS);
  escalate.unref?.();
}

export function codexEnv(apiKey?: string): NodeJS.ProcessEnv | undefined {
  const codex = resolveCodex();
  if (!codex.env && !apiKey) return undefined;
  // CODEX_API_KEY is the exec-scoped key OpenAI's own SDK sets. A ChatGPT-plan
  // login also works but is the user's own arrangement, not a path we support.
  return { ...(codex.env ?? process.env), ...(apiKey ? { CODEX_API_KEY: apiKey } : {}) };
}

/** TOML-quote a value for `-c key=value`. Codex parses the value as TOML and
 *  falls back to a raw literal — JSON.stringify yields a valid TOML basic
 *  string for the free text we pass, escapes and newlines included. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export const CODEX_NOT_INSTALLED =
  "Codex CLI is not installed or not in your PATH.\n\n" +
  "To fix this:\n" +
  "  1. Install Codex: npm install -g @openai/codex (or brew install codex)\n" +
  "  2. Authenticate: set an API key in Settings, or run `codex login`\n" +
  "  3. Restart Skipper (on Windows, a fresh install only lands on the PATH of NEW processes)\n\n" +
  "Alternatively, pick a different provider in Settings.";

interface ExecResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export class CodexCLIProvider implements LLMProviderInterface {
  readonly name = "codex-cli" as const;

  constructor(
    private model: string = DEFAULT_CODEX_MODEL,
    private apiKey?: string,
  ) {}

  async ask(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    return this.exec({
      prompt,
      extra: [...this.singleShotFlags(), ...developerInstructions(systemPrompt)],
    });
  }

  async askStructured<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "skipper-codex-"));
    const schemaFile = join(dir, "schema.json");
    try {
      writeFileSync(schemaFile, JSON.stringify(schema), "utf-8");
      // --output-schema constrains the response server-side, so unlike the
      // claude path there's no schema inlined into the prompt. Still routed
      // through parseJsonReply for free tolerance if codex ever wraps it.
      const res = await this.exec({
        prompt,
        extra: [...this.singleShotFlags(), "--output-schema", schemaFile],
      });
      return parseJsonReply<T>(res.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async agent(prompt: string, opts: AgentOptions = {}): Promise<LLMResponse> {
    // opts.maxTurns is unenforceable: codex has no --max-turns and no config
    // equivalent. The wall-clock bound below is the only ceiling on a run.
    return this.exec({
      prompt,
      cwd: opts.cwd,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      extra: [...this.singleShotFlags(), ...developerInstructions(opts.systemPrompt)],
    });
  }

  private singleShotFlags(): string[] {
    return ["--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", ...modelFlag(this.model)];
  }

  private exec(opts: {
    prompt: string;
    extra: string[];
    cwd?: string;
    onEvent?: (event: CodingEvent) => void;
  }): Promise<ExecResult> {
    const dir = mkdtempSync(join(tmpdir(), "skipper-codex-"));
    const outFile = join(dir, "last.txt");
    const args = ["exec", ...BASE_FLAGS, ...opts.extra, "-o", outFile, "-"];

    return runCodex(args, opts.prompt, opts.cwd, this.apiKey, opts.onEvent)
      .then((res) => {
        // -o holds the untruncated final message; the mapped result summary is
        // capped, and turn.completed carries no text at all.
        const text = existsSync(outFile) ? readFileSync(outFile, "utf-8").trim() : res.summary;
        return { text, ...(res.usage ? { usage: res.usage } : {}) };
      })
      .finally(() => rmSync(dir, { recursive: true, force: true }));
  }
}

/** Blank model = let codex resolve its own. Pinning is right for an API key,
 *  but a ChatGPT-plan login rejects an explicit model outright ("not supported
 *  when using Codex with a ChatGPT account") — blank is that user's escape
 *  hatch, so never send `--model ""`. */
export function modelFlag(model: string): string[] {
  return model.trim() ? ["--model", model.trim()] : [];
}

function developerInstructions(systemPrompt?: string): string[] {
  if (!systemPrompt) return [];
  // exec sets developer_instructions: None and defines no flag for it, so the
  // TOML key is the only seam.
  return ["-c", `developer_instructions=${tomlString(systemPrompt)}`];
}

interface RunResult {
  summary: string;
  usage?: { inputTokens: number; outputTokens: number };
}

function runCodex(
  args: string[],
  prompt: string,
  cwd: string | undefined,
  apiKey: string | undefined,
  onEvent?: (event: CodingEvent) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const codex = resolveCodex();
    const env = codexEnv(apiKey);
    const proc = spawn(codex.file, [...codex.argsPrefix, ...args], {
      cwd: cwd ?? tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // New process group so a timeout can take out codex's child shells too.
      detached: process.platform !== "win32",
      ...(env ? { env } : {}),
    });

    let stderr = "";
    let settled = false;
    let completed: RunResult | null = null;
    let failure: string | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killCodexTree(proc);
      reject(new Error("codex run exceeded the time limit — killed"));
    }, DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    // The parser grafts the last agent_message onto the result as `summary`,
    // which is the fallback when -o didn't land.
    const parser = createCodexStreamParser(
      (event) => {
        if (event.kind === "result" && event.ok) {
          completed = {
            summary: event.summary ?? "",
            ...(event.usage ? { usage: event.usage } : {}),
          };
        }
        onEvent?.(event);
      },
      (line) => {
        if (line.type === "turn.failed") {
          const error = line.error as Record<string, unknown> | undefined;
          failure = typeof error?.message === "string" ? error.message : "codex run failed";
        }
      },
    );

    proc.stdout.on("data", (data: Buffer) => parser.feed(data.toString()));
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      parser.flush();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Success is a terminal turn.completed, never the exit code: an empty
      // stdout must read as a failure, not as an empty answer.
      if (failure) reject(new Error(`Codex CLI error: ${failure}`));
      else if (completed) resolve(completed);
      else
        reject(
          new Error(`codex exited with code ${code} without a result: ${stderr.slice(-2000)}`),
        );
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        resolvedCodex = null;
        reject(new Error(CODEX_NOT_INSTALLED));
      } else {
        reject(err);
      }
    });

    // `-` makes codex read the prompt from stdin, dodging argv length limits.
    // Ending the pipe is what keeps this out of the known deadlock: codex
    // blocks forever on a non-TTY stdin that has a writer but never closes.
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
