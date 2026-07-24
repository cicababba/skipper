// Graphify knowledge-graph MCP wiring (#233). The planner run attaches the
// graphify-mcp stdio server, scoped to a single repo's on-disk graph.json, so it
// can query the tree-sitter AST index while exploring the code. Unlike the
// skipper-memory server, graphify-mcp is a native executable — no
// ELECTRON_RUN_AS_NODE node-under-Electron trick.

export interface GraphifyMcp {
  /** Absolute path to the graphify-mcp executable in userData. */
  mcpBinPath: string;
  /** Absolute path to the repo's graph.json. */
  graphPath: string;
}

/** The 7 local graph tools, as claude sees them (server name + tool). The 3
 *  GitHub/PR tools the server also exposes are network-touching and excluded. */
export const GRAPHIFY_TOOLS =
  "mcp__graphify__query_graph,mcp__graphify__get_node,mcp__graphify__get_neighbors,mcp__graphify__get_community,mcp__graphify__god_nodes,mcp__graphify__graph_stats,mcp__graphify__shortest_path";

/** The graphify-mcp stdio server entry, keyed "graphify" so tools surface as
 *  mcp__graphify__<tool>. */
export function graphifyServerConfig(g: GraphifyMcp): {
  command: string;
  args: string[];
} {
  return { command: g.mcpBinPath, args: ["--graph", g.graphPath] };
}

/** The planner-facing view of a repo's graph. currentBaseSha is set only when the
 *  index is stale relative to the freshly resolved base ref. */
export interface GraphifyContext {
  mcp: GraphifyMcp;
  indexedSha: string;
  currentBaseSha?: string;
}

/** The prompt section that accompanies the server — declares the graph exists,
 *  the indexed SHA vs current base, and that it is a map to verify against. */
export function renderGraphifySection(ctx: GraphifyContext): string {
  const stale =
    ctx.currentBaseSha && ctx.currentBaseSha !== ctx.indexedSha
      ? `, base has advanced to \`${ctx.currentBaseSha}\``
      : "";
  return [
    "## Repository knowledge graph",
    "",
    `A local knowledge-graph index of this repository is available via the \`mcp__graphify__*\` tools (index built at \`${ctx.indexedSha}\`${stale}).`,
    "Use it as a map — verify against the code before citing symbols or paths.",
  ].join("\n");
}
