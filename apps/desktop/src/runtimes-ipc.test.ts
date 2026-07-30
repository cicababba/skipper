import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeAvailability } from "@skipper/shared";
import { registerRuntimesHandlers, type RuntimesIpcDeps } from "./runtimes-ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const WIN_ENV = {
  USERPROFILE: "C:\\Users\\dev",
  APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
};

interface SetupOptions {
  platform?: NodeJS.Platform;
  /** Binaries the `command -v` / `where` probe resolves. */
  onPath?: string[];
  existingPaths?: string[];
  env?: Record<string, string | undefined>;
}

function setup(opts: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const onPath = opts.onPath ?? [];
  const exec = vi.fn((cmd: string) => {
    const bin = cmd.split(" ").pop() as string;
    if (!onPath.includes(bin)) throw new Error(`not found: ${bin}`);
  });
  const existingPaths = opts.existingPaths ?? [];
  const fileExists = vi.fn((p: string) => existingPaths.includes(p));
  const deps = {
    ipcMain,
    exec,
    fileExists,
    platform: opts.platform ?? "darwin",
    env: opts.env ?? {},
  } as unknown as RuntimesIpcDeps;
  registerRuntimesHandlers(deps);
  const handler = handlers.get("skipper:runtimes:status");
  if (!handler) throw new Error("handler not registered");
  const status = () => handler(null) as RuntimeAvailability;
  return { handlers, status, exec, fileExists };
}

describe("registerRuntimesHandlers", () => {
  it("registers the status channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual(["skipper:runtimes:status"]);
  });

  it("reports exactly the four runtime ids", () => {
    const { status } = setup({ onPath: ["claude"] });
    expect(status()).toEqual({
      "claude-cli": true,
      "codex-cli": false,
      "copilot-cli": false,
      "gemini-cli": false,
    });
  });

  it("probes every binary with command -v on POSIX", () => {
    const { status, exec } = setup({ platform: "darwin", onPath: ["claude", "gemini"] });
    expect(status()).toEqual({
      "claude-cli": true,
      "codex-cli": false,
      "copilot-cli": false,
      "gemini-cli": true,
    });
    expect(exec.mock.calls.map(([cmd]) => cmd)).toEqual([
      "command -v claude",
      "command -v codex",
      "command -v copilot",
      "command -v gemini",
    ]);
  });

  it("probes every binary with where on win32", () => {
    const { status, exec } = setup({ platform: "win32", env: WIN_ENV, onPath: ["codex"] });
    expect(status()["codex-cli"]).toBe(true);
    expect(exec.mock.calls.map(([cmd]) => cmd)).toEqual([
      "where claude",
      "where codex",
      "where copilot",
      "where gemini",
    ]);
  });

  it("reports a binary the probe cannot resolve as missing", () => {
    const { status, fileExists } = setup({ platform: "linux", onPath: [] });
    expect(Object.values(status())).toEqual([false, false, false, false]);
    // POSIX has no known-location fallback — the resolvers only check them on win32.
    expect(fileExists).not.toHaveBeenCalled();
  });

  it.each([
    ["native installer", (env: typeof WIN_ENV) => join(env.USERPROFILE, ".local", "bin", "claude.exe")],
    ["programs dir", (env: typeof WIN_ENV) => join(env.LOCALAPPDATA, "Programs", "claude", "claude.exe")],
    ["npm cmd shim", (env: typeof WIN_ENV) => join(env.APPDATA, "npm", "claude.cmd")],
    ["npm exe shim", (env: typeof WIN_ENV) => join(env.APPDATA, "npm", "claude.exe")],
  ])("falls back to the %s path on win32 when the probe fails", (_label, path) => {
    const { status } = setup({
      platform: "win32",
      env: WIN_ENV,
      onPath: [],
      existingPaths: [path(WIN_ENV)],
    });
    expect(status()).toEqual({
      "claude-cli": true,
      "codex-cli": false,
      "copilot-cli": false,
      "gemini-cli": false,
    });
  });

  it("skips fallback paths whose env var is unset", () => {
    const { status, fileExists } = setup({ platform: "win32", env: {}, onPath: [] });
    expect(Object.values(status())).toEqual([false, false, false, false]);
    expect(fileExists).not.toHaveBeenCalled();
  });

  it("probes again on every call — a restart is what picks up a new install", () => {
    const { status, exec } = setup({ platform: "darwin", onPath: ["claude"] });
    status();
    status();
    expect(exec).toHaveBeenCalledTimes(8);
  });
});
