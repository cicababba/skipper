import { describe, it, expect } from "vitest";
import { buildMcpConfigArgs } from "./mcp-config";
import { buildMemoryMcpArgs } from "./memory-mcp";

const MEM = {
  cliBundlePath: "/opt/app/skipper.bundle.cjs",
  repo: { owner: "acme", name: "rocket" },
};
const GRAPH = {
  mcpBinPath: "/data/tools/bin/graphify-mcp",
  graphPath: "/data/graphs/acme_rocket/graphify-out/graph.json",
};

describe("buildMcpConfigArgs", () => {
  it("is byte-identical to buildMemoryMcpArgs for the memory-only case", () => {
    // The historical builder now delegates here — this is its regression contract.
    expect(buildMcpConfigArgs(MEM)).toEqual(buildMemoryMcpArgs(MEM));
    const config = JSON.parse(buildMcpConfigArgs(MEM)[1]);
    expect(Object.keys(config.mcpServers)).toEqual(["skipper-memory"]);
  });

  it("emits only the graphify server for the graph-only case", () => {
    const args = buildMcpConfigArgs(undefined, GRAPH);
    expect(args).toHaveLength(3);
    expect(args[0]).toBe("--mcp-config");
    expect(args[2]).toBe("--strict-mcp-config");
    const config = JSON.parse(args[1]);
    expect(Object.keys(config.mcpServers)).toEqual(["graphify"]);
    expect(config.mcpServers.graphify).toEqual({
      command: GRAPH.mcpBinPath,
      args: ["--graph", GRAPH.graphPath],
    });
  });

  it("carries both servers in ONE --mcp-config with ONE --strict-mcp-config", () => {
    const args = buildMcpConfigArgs(MEM, GRAPH);
    expect(args).toHaveLength(3);
    expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1);
    expect(args.filter((a) => a === "--strict-mcp-config")).toHaveLength(1);
    const config = JSON.parse(args[1]);
    expect(Object.keys(config.mcpServers).sort()).toEqual(["graphify", "skipper-memory"]);
  });

  it("returns [] when neither server is present", () => {
    expect(buildMcpConfigArgs()).toEqual([]);
    expect(buildMcpConfigArgs(undefined, undefined)).toEqual([]);
  });
});
