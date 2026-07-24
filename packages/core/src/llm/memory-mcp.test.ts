import { describe, it, expect } from "vitest";
import { MEMORY_TOOLS, buildMemoryMcpArgs } from "./memory-mcp";

describe("buildMemoryMcpArgs", () => {
  const mem = { cliBundlePath: "/opt/app/skipper.bundle.cjs", repo: { owner: "acme", name: "rocket" } };

  it("emits --mcp-config + --strict-mcp-config", () => {
    const args = buildMemoryMcpArgs(mem);
    expect(args[0]).toBe("--mcp-config");
    expect(args[2]).toBe("--strict-mcp-config");
    expect(args).toHaveLength(3);
  });

  it("scopes the server to the repo and runs the bundle under the app runtime", () => {
    const config = JSON.parse(buildMemoryMcpArgs(mem)[1]);
    const server = config.mcpServers["skipper-memory"];
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([
      "/opt/app/skipper.bundle.cjs",
      "memory",
      "serve",
      "--repo",
      "acme/rocket",
    ]);
    expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("exposes both tool names for --tools / --allowedTools", () => {
    expect(MEMORY_TOOLS).toBe(
      "mcp__skipper-memory__search_memory,mcp__skipper-memory__get_memory",
    );
  });
});
