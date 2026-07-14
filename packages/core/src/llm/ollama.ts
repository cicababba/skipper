import { readFile, readdir } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import type { AgentOptions, LLMProviderInterface, LLMResponse } from "./provider";

/**
 * Local Ollama server. Talks to the REST API exposed by `ollama serve`
 * (default http://127.0.0.1:11434). No API key — the models run on the
 * user's own machine. Override the host with the OLLAMA_HOST env var.
 *
 * Tool-capable models (those whose `ollama show` lists the `tools`
 * capability — e.g. gemma3/4, llama3.x, qwen2.5/3, mistral) can run the
 * agentic flow via `agent()`: a local tool-calling loop with read-only
 * filesystem + web-fetch tools, scoped to the workspace. Models without
 * tool support transparently fall back to a plain completion.
 */
export const OLLAMA_DEFAULT_HOST = "http://127.0.0.1:11434";

export function ollamaHost(): string {
  return (process.env.OLLAMA_HOST || OLLAMA_DEFAULT_HOST).replace(/\/$/, "");
}

interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
  tool_name?: string;
}

export class OllamaProvider implements LLMProviderInterface {
  readonly name = "ollama" as const;
  private baseUrl: string;

  constructor(
    private model: string = "llama3",
    baseUrl?: string,
  ) {
    this.baseUrl = (baseUrl || ollamaHost()).replace(/\/$/, "");
  }

  private async chat(body: Record<string, unknown>): Promise<{ message: ChatMessage; prompt_eval_count?: number; eval_count?: number }> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream: false, ...body }),
    });
    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async ask(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const data = await this.chat({ model: this.model, messages });
    return {
      text: data.message?.content ?? "",
      usage:
        data.prompt_eval_count != null || data.eval_count != null
          ? { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 }
          : undefined,
    };
  }

  async askStructured<T>(
    prompt: string,
    schema: Record<string, unknown>,
  ): Promise<T> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `Respond ONLY with valid JSON matching this schema: ${JSON.stringify(schema)}`,
      },
      { role: "user", content: prompt },
    ];
    // `format: "json"` constrains Ollama to emit a single JSON value.
    const data = await this.chat({ model: this.model, messages, format: "json" });
    return JSON.parse(data.message?.content ?? "{}") as T;
  }

  /**
   * Agentic completion using Ollama's native tool calling. Runs a loop:
   * send messages + tool defs → if the model returns tool_calls, execute the
   * (read-only, workspace-scoped) tools and feed results back → repeat until
   * the model answers with plain content or we hit the turn budget. If the
   * model doesn't support tools, falls back to a single plain completion.
   */
  async agent(prompt: string, opts: AgentOptions = {}): Promise<LLMResponse> {
    const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
    const maxTurns = opts.maxTurns ?? 12;

    const messages: ChatMessage[] = [];
    if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
    messages.push({ role: "user", content: prompt });

    let toolsEnabled = true;
    const usage = { inputTokens: 0, outputTokens: 0 };

    for (let turn = 0; turn < maxTurns; turn++) {
      let data;
      try {
        data = await this.chat({
          model: this.model,
          messages,
          ...(toolsEnabled ? { tools: OLLAMA_TOOLS } : {}),
        });
      } catch (err) {
        // Model likely doesn't support tools — retry once without them.
        if (toolsEnabled && /tool/i.test(err instanceof Error ? err.message : String(err))) {
          toolsEnabled = false;
          continue;
        }
        throw err;
      }

      usage.inputTokens += data.prompt_eval_count ?? 0;
      usage.outputTokens += data.eval_count ?? 0;
      const msg = data.message ?? { role: "assistant", content: "" };
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        return { text: msg.content ?? "", usage };
      }

      for (const call of calls) {
        const name = call.function?.name ?? "";
        const args = call.function?.arguments ?? {};
        let result: string;
        try {
          result = await runOllamaTool(name, args, cwd);
        } catch (e) {
          result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
        }
        messages.push({ role: "tool", tool_name: name, content: result });
      }
    }

    // Out of turns — force a final answer with no tools.
    messages.push({ role: "user", content: "Stop using tools and produce the final result now." });
    const final = await this.chat({ model: this.model, messages });
    usage.inputTokens += final.prompt_eval_count ?? 0;
    usage.outputTokens += final.eval_count ?? 0;
    return { text: final.message?.content ?? "", usage };
  }
}

// ───────────────────────── agent tools ─────────────────────────

const OLLAMA_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and subfolders inside a directory of the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path relative to the workspace root. Use '.' for the root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path relative to the workspace root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "Search the workspace for files containing a case-insensitive substring. Returns matching file:line snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for." },
          path: { type: "string", description: "Optional subfolder to limit the search to (relative to root)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL (e.g. a GitHub page or raw file) and return its readable text content.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL." } },
        required: ["url"],
      },
    },
  },
];

const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache"]);

/** Resolve a user-supplied path and confine it to the workspace root. */
function safeResolve(cwd: string, p: string): string {
  const target = resolve(cwd, p ?? ".");
  if (target !== cwd && !target.startsWith(cwd + sep)) {
    throw new Error("path is outside the workspace");
  }
  return target;
}

async function runOllamaTool(name: string, args: Record<string, unknown>, cwd: string): Promise<string> {
  switch (name) {
    case "list_directory": {
      const dir = safeResolve(cwd, String(args.path ?? "."));
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries
        .filter((e) => !e.name.startsWith("."))
        .slice(0, 300)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return lines.length ? lines.join("\n") : "(empty)";
    }
    case "read_file": {
      const file = safeResolve(cwd, String(args.path ?? ""));
      const buf = await readFile(file, "utf-8");
      const MAX = 60_000;
      return buf.length > MAX ? buf.slice(0, MAX) + "\n…(truncated)" : buf;
    }
    case "search_text": {
      const query = String(args.query ?? "").toLowerCase();
      if (!query) return "(empty query)";
      const root = safeResolve(cwd, String(args.path ?? "."));
      const hits = await searchText(root, cwd, query, 40);
      return hits.length ? hits.join("\n") : "(no matches)";
    }
    case "web_fetch": {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s)");
      return webFetch(url);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function searchText(dir: string, cwd: string, query: string, limit: number, acc: string[] = []): Promise<string[]> {
  if (acc.length >= limit) return acc;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= limit) break;
    if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await searchText(full, cwd, query, limit, acc);
    } else if (/\.(ts|tsx|js|jsx|md|mdx|json|txt|yml|yaml|toml|css|html|py|go|rs|java|c|h|cpp|sh)$/i.test(e.name)) {
      try {
        const content = await readFile(full, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && acc.length < limit; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            acc.push(`${relative(cwd, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  return acc;
}

async function webFetch(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Skipper/1.6 (+ollama-agent)" } });
    if (!res.ok) return `HTTP ${res.status} fetching ${url}`;
    const raw = await res.text();
    // Crude HTML → text: drop scripts/styles/tags, collapse whitespace.
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const MAX = 80_000;
    return text.length > MAX ? text.slice(0, MAX) + " …(truncated)" : text;
  } finally {
    clearTimeout(timer);
  }
}
