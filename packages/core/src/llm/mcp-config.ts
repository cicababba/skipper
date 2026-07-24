import { memoryServerConfig, type MemoryMcp } from "./memory-mcp";
import { graphifyServerConfig, type GraphifyMcp } from "./graphify-mcp";

// One `--mcp-config` (+ one `--strict-mcp-config`) carries every stdio server a
// run needs (#233). The planner may attach both the skipper-memory server and
// the graphify server; they must share a single config object, so this is the
// one builder both go through. Memory-only output is byte-identical to the
// historical buildMemoryMcpArgs (its regression contract).
export function buildMcpConfigArgs(memory?: MemoryMcp, graph?: GraphifyMcp): string[] {
  const mcpServers: Record<string, unknown> = {};
  if (memory) mcpServers["skipper-memory"] = memoryServerConfig(memory);
  if (graph) mcpServers["graphify"] = graphifyServerConfig(graph);
  if (Object.keys(mcpServers).length === 0) return [];
  return ["--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config"];
}
