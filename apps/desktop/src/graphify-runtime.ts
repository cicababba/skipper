// Graphify runtime: uv-managed install + extract (#233). Pure Node module over
// execFile — no electron import, so it stays unit-testable; callers inject the
// uv binary and tools directory. Everything (a standalone Python, graphifyy, its
// two executables) lives isolated under UV_TOOL_DIR in userData; the app never
// touches system Python or PATH.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Pinned graphify pip-spec. The [mcp] extra is required or graphify-mcp crashes
 *  with ModuleNotFoundError: mcp. Bumping this triggers a reinstall (spec marker). */
export const GRAPHIFY_PIP_SPEC = "graphifyy[mcp]==0.9.25";

export interface GraphifyRuntime {
  /** uv binary — "uv" from PATH in dev, an absolute packaged path in production. */
  uvBin: string;
  /** <userData>/tools — the UV_TOOL_DIR root everything installs under. */
  toolsDir: string;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_TIMEOUT_MS = 15 * 60_000;

/** The env that isolates every uv operation inside toolsDir. */
export function uvEnv(toolsDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UV_TOOL_DIR: join(toolsDir, "uv"),
    UV_TOOL_BIN_DIR: join(toolsDir, "bin"),
    UV_PYTHON_INSTALL_DIR: join(toolsDir, "python"),
  };
}

function withExe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

export function graphifyBin(toolsDir: string): string {
  return join(toolsDir, "bin", withExe("graphify"));
}

export function graphifyMcpBin(toolsDir: string): string {
  return join(toolsDir, "bin", withExe("graphify-mcp"));
}

function specMarkerPath(toolsDir: string): string {
  return join(toolsDir, "graphify.spec");
}

/** Installed = both executables present and the spec marker matches the current
 *  pin (a bumped GRAPHIFY_PIP_SPEC forces a reinstall). */
export async function isGraphifyInstalled(toolsDir: string): Promise<boolean> {
  if (!existsSync(graphifyBin(toolsDir)) || !existsSync(graphifyMcpBin(toolsDir))) return false;
  try {
    return (await readFile(specMarkerPath(toolsDir), "utf-8")).trim() === GRAPHIFY_PIP_SPEC;
  } catch {
    return false;
  }
}

/** No-op when already installed; else `uv tool install` under the isolating env,
 *  then write the spec marker. Errors propagate. */
export async function ensureGraphifyInstalled(rt: GraphifyRuntime): Promise<void> {
  if (await isGraphifyInstalled(rt.toolsDir)) return;
  await run(
    rt.uvBin,
    ["tool", "install", GRAPHIFY_PIP_SPEC, "--python", "3.12"],
    { env: uvEnv(rt.toolsDir), timeoutMs: INSTALL_TIMEOUT_MS },
  );
  await writeFile(specMarkerPath(rt.toolsDir), GRAPHIFY_PIP_SPEC, "utf-8");
}

/** Extract the code-only knowledge graph of a checkout into outDir/graphify-out/. */
export async function runGraphifyExtract(
  rt: GraphifyRuntime,
  worktreePath: string,
  outDir: string,
): Promise<void> {
  await run(
    graphifyBin(rt.toolsDir),
    ["extract", worktreePath, "--code-only", "--out", outDir],
    { env: uvEnv(rt.toolsDir), timeoutMs: EXTRACT_TIMEOUT_MS },
  );
}

/** execFile wrapper modeled on runGit: capped buffer, throws with truncated stderr. */
function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim().slice(0, 500);
          reject(new Error(`${cmd} ${args[0]} failed: ${detail || `exit ${error.code ?? 1}`}`));
        } else {
          resolve();
        }
      },
    );
  });
}
