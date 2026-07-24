import { describe, it, expect } from "vitest";
import {
  GRAPHIFY_TOOLS,
  graphifyServerConfig,
  renderGraphifySection,
  type GraphifyContext,
} from "./graphify-mcp";

const MCP = {
  mcpBinPath: "/data/tools/bin/graphify-mcp",
  graphPath: "/data/graphs/acme_rocket/graphify-out/graph.json",
};

describe("graphifyServerConfig", () => {
  it("launches the native executable against the repo's graph.json", () => {
    const config = graphifyServerConfig(MCP);
    expect(config.command).toBe(MCP.mcpBinPath);
    expect(config.args).toEqual(["--graph", MCP.graphPath]);
    // Native executable — no ELECTRON_RUN_AS_NODE env trick (unlike memory).
    expect("env" in config).toBe(false);
  });
});

describe("GRAPHIFY_TOOLS", () => {
  it("is exactly the 7 prefixed local graph tools", () => {
    expect(GRAPHIFY_TOOLS).toBe(
      "mcp__graphify__query_graph,mcp__graphify__get_node,mcp__graphify__get_neighbors,mcp__graphify__get_community,mcp__graphify__god_nodes,mcp__graphify__graph_stats,mcp__graphify__shortest_path",
    );
    const names = GRAPHIFY_TOOLS.split(",");
    expect(names).toHaveLength(7);
    expect(names.every((n) => n.startsWith("mcp__graphify__"))).toBe(true);
    // The 3 network-touching GitHub/PR tools are excluded by the allowlist.
    expect(GRAPHIFY_TOOLS).not.toContain("list_prs");
    expect(GRAPHIFY_TOOLS).not.toContain("get_pr_impact");
    expect(GRAPHIFY_TOOLS).not.toContain("triage_prs");
  });
});

describe("renderGraphifySection", () => {
  it("declares the graph and the indexed SHA when fresh", () => {
    const ctx: GraphifyContext = { mcp: MCP, indexedSha: "abc1234def" };
    const section = renderGraphifySection(ctx);
    expect(section).toContain("## Repository knowledge graph");
    expect(section).toContain("mcp__graphify__");
    expect(section).toContain("`abc1234def`");
    expect(section).toContain("verify against the code");
    expect(section).not.toContain("base has advanced");
  });

  it("declares the advanced base when stale", () => {
    const ctx: GraphifyContext = {
      mcp: MCP,
      indexedSha: "abc1234def",
      currentBaseSha: "999fedc888",
    };
    const section = renderGraphifySection(ctx);
    expect(section).toContain("`abc1234def`");
    expect(section).toContain("base has advanced to `999fedc888`");
  });

  it("stays fresh when currentBaseSha equals the indexed SHA", () => {
    const ctx: GraphifyContext = {
      mcp: MCP,
      indexedSha: "abc1234def",
      currentBaseSha: "abc1234def",
    };
    expect(renderGraphifySection(ctx)).not.toContain("base has advanced");
  });
});
