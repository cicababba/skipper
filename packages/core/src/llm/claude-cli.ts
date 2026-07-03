import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "./provider";

/**
 * Pull a JSON object/array out of a model reply that may contain a fenced
 * code block, prose preamble, or trailing chatter. We try strict parse first,
 * then look for the largest balanced { … } or [ … ] block.
 */
function parseJsonReply<T>(text: string): T {
  const t = text.trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    /* fall through */
  }
  // Strip a single fenced code block if the whole reply is wrapped in one.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      /* fall through */
    }
  }
  // Find the first { or [ and try to balance-match to its closer. Naive
  // (ignores strings) but works for typical model replies.
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const open = t[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const slice = t.slice(start, i + 1);
          return JSON.parse(slice) as T;
        }
      }
    }
  }
  throw new Error(`No parseable JSON in model reply: ${t.slice(0, 200)}…`);
}

// On Windows, `spawn("claude")` can't execute the npm shim (claude.cmd /
// claude.ps1): Node refuses .cmd files without a shell, and a shell would
// wreck arg quoting (--system-prompt carries free text). Resolve the real
// target once: a native claude.exe spawns directly; an npm shim is bypassed
// by running its cli.js under our own runtime (ELECTRON_RUN_AS_NODE inside
// the packaged app, plain node otherwise).
interface ClaudeCmd {
  file: string;
  argsPrefix: string[];
  env?: NodeJS.ProcessEnv;
}
let resolvedClaude: ClaudeCmd | null = null;

function resolveClaude(): ClaudeCmd {
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

function runClaude(args: string[], stdin?: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const claude = resolveClaude();
    const proc = spawn(claude.file, [...claude.argsPrefix, ...args], {
      cwd: cwd ?? tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 600_000,
      ...(claude.env ? { env: claude.env } : {}),
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolvedClaude = null; // re-resolve next time — claude may get installed mid-session
        reject(
          new Error(
            'Claude CLI is not installed or not in your PATH.\n\n' +
            'To fix this:\n' +
            '  1. Install Claude Code: npm install -g @anthropic-ai/claude-code\n' +
            '  2. Authenticate: claude auth login\n' +
            '  3. Restart NestBrain (on Windows, a fresh install only lands on the PATH of NEW processes)\n\n' +
            'Alternatively, switch to the OpenAI provider in Settings.',
          ),
        );
      } else {
        reject(err);
      }
    });

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
      throw new Error(`Claude CLI error: ${data.result}`);
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
    const args = [
      "-p",
      "-",
      "--output-format",
      "json",
      "--model",
      this.model,
      "--max-turns",
      String(opts.maxTurns ?? 24),
      "--no-session-persistence",
      "--disable-slash-commands",
      // Enable a capable but read-leaning toolset so the agent can inspect
      // local code and the web. `--tools` limits what's available (no
      // Edit/Write — we persist the result ourselves), and `--allowedTools`
      // pre-approves them so they run without a prompt in headless (-p) mode,
      // where an approval request would otherwise be auto-denied. Keep
      // --setting-sources empty so the user's global skills / project
      // CLAUDE.md don't hijack the run.
      "--tools",
      "Read,Grep,Glob,WebFetch,WebSearch,Bash",
      "--allowedTools",
      "Read,Grep,Glob,WebFetch,WebSearch,Bash",
      "--setting-sources",
      "",
    ];

    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    const stdout = await runClaude(args, prompt, opts.cwd);
    const data = JSON.parse(stdout);
    if (data.is_error) {
      throw new Error(`Claude CLI error: ${data.result}`);
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

  async askStructured<T>(
    prompt: string,
    schema: Record<string, unknown>,
  ): Promise<T> {
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
      "--disable-slash-commands",
      "--tools",
      "",
      "--setting-sources",
      "",
    ];

    // --json-schema in the current Claude CLI is a soft hint that triggers
    // tool-use mode (StructuredOutput tool), which doesn't compose well with
    // --tools "". We instead inline the schema in the prompt and require the
    // model to reply with JSON-only — then extract.
    const inlined =
      `${prompt}\n\n--\nReply with ONLY a single JSON value matching this JSON Schema. No prose, no code fences, no preamble.\n\nSchema:\n${JSON.stringify(schema)}`;
    const stdout = await runClaude(args, inlined);

    const data = JSON.parse(stdout);
    if (data.is_error) {
      throw new Error(`Claude CLI error: ${data.result}`);
    }

    return parseJsonReply<T>(data.result ?? "");
  }
}
