import { repoKey, type RepoRef } from "@skipper/shared";
import { buildMcpConfigArgs } from "./mcp-config";

// Solutions-memory MCP wiring (#45). Every planner/coder run passes
// --setting-sources "" so no user/project MCP config loads — the
// skipper-memory server must be injected explicitly. It is the CLI itself
// (`skipper memory serve`) run under the app's own runtime, scoped to the
// item's repo so a run can only search its own repo's memory.

export interface MemoryMcp {
  /** Absolute path to the packaged CLI bundle (skipper.bundle.cjs). */
  cliBundlePath: string;
  /** Repo scope — the server only exposes this repo's records. */
  repo: RepoRef;
}

/** The two tool names, as claude sees them (server name + tool). */
export const MEMORY_TOOLS =
  "mcp__skipper-memory__search_memory,mcp__skipper-memory__get_memory";

/**
 * The skipper-memory stdio server entry. `process.execPath` +
 * ELECTRON_RUN_AS_NODE=1 is the same node-under-Electron trick `resolveClaude()`
 * uses: no assumption that `node` or `skipper` is on PATH, Windows-safe.
 */
export function memoryServerConfig(mem: MemoryMcp): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: process.execPath,
    args: [mem.cliBundlePath, "memory", "serve", "--repo", repoKey(mem.repo)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * The `--mcp-config` (+ `--strict-mcp-config`) flags that launch the
 * skipper-memory stdio server. The tool names still have to be added to both
 * --tools and --allowedTools by the caller (headless -p auto-denies otherwise).
 */
export function buildMemoryMcpArgs(mem: MemoryMcp): string[] {
  return buildMcpConfigArgs(mem);
}
