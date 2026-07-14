// skipper-memory MCP server (#45). A stdio server hosted by the CLI and
// injected into every planner/coder run via --mcp-config, scoped to one repo so
// a run can only search its own repo's solutions memory. Two tools:
//   search_memory(query, k?) → ranked summaries (cheap; id + gist + files)
//   get_memory(id)           → the full record (plan + diff) for one hit
// The two-step keeps token cost sane. stdout is the protocol channel — nothing
// but MCP framing may be written to it.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  searchMemory,
  readSolutionRecord,
  memoryFileName,
} from "@skipper/core";
import { repoKey, type RepoRef } from "@skipper/shared";

export interface ServeMemoryOptions {
  /** Repo scope — the only repo whose records this server exposes. */
  repo: RepoRef;
  /** <userData>/memory — record files + vector index. */
  memoryDir: string;
}

interface ToolResult {
  // Index signature keeps this assignable to the SDK's CallToolResult while
  // typing `content[].text` narrowly for callers/tests.
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** search_memory tool body — extracted for direct testing. */
export async function runSearchMemory(
  opts: ServeMemoryOptions,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) {
    return { content: [{ type: "text", text: "query is required" }], isError: true };
  }
  const k = typeof args.k === "number" && args.k > 0 ? Math.floor(args.k) : undefined;
  const hits = await searchMemory(opts.memoryDir, query, { repo: opts.repo, k });
  const summaries = hits.map((h) => ({
    id: h.id,
    issue: h.issueNumber,
    url: h.url,
    pr: h.pr,
    title: h.title,
    score: Number(h.score.toFixed(3)),
    planSummary: h.planSummary,
    filesTouched: h.filesTouched,
    capturedAt: h.capturedAt,
  }));
  return { content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }] };
}

/** get_memory tool body — extracted for direct testing. */
export async function runGetMemory(
  opts: ServeMemoryOptions,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) {
    return { content: [{ type: "text", text: "id is required" }], isError: true };
  }
  const record = await readSolutionRecord(opts.memoryDir, memoryFileName(id));
  // Scope guard: never serve another repo's record even if its id is guessed.
  if (!record || repoKey(record.repo) !== repoKey(opts.repo)) {
    return { content: [{ type: "text", text: `No memory record found for id "${id}".` }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }] };
}

const TOOLS = [
  {
    name: "search_memory",
    description:
      "Search this repo's solutions memory (past merged issues) for ones similar to a query. Returns ranked summaries — id, issue/PR refs, title, plan gist, files touched. Follow up with get_memory(id) for the full plan and diff of a promising hit.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you're trying to solve — issue title/summary or keywords.",
        },
        k: {
          type: "number",
          description: "Max results (default 5).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_memory",
    description:
      "Fetch the full solution record for one memory id (from a search_memory hit): the stored plan and the merged diff.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory id from a search_memory hit." },
      },
      required: ["id"],
    },
  },
];

/** Start the stdio server and connect it. Resolves once connected; the
 * transport keeps the process alive on stdin. */
export async function serveMemory(opts: ServeMemoryOptions): Promise<void> {
  // Guard the protocol channel: any stray library stdout write (e.g. a model
  // download progress line) would corrupt MCP framing. Route console.log to
  // stderr for the lifetime of this dedicated subprocess.
  console.log = console.error;

  const server = new Server(
    { name: "skipper-memory", version: "1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (name === "search_memory") return runSearchMemory(opts, args);
    if (name === "get_memory") return runGetMemory(opts, args);
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  });

  await server.connect(new StdioServerTransport());
}
