import { resolve } from "node:path";

// Run confinement (#196): keep an agent run from touching anything outside its
// worktree — above all the user's linked repo checkout. Two enforced layers are
// built from this type: path-scoped tool pre-approval (Edit/Write rules bound to
// the run root) and a PreToolUse guard hook (Bash command + Edit/Write file_path
// checks). The guard runs as the `skipper guard` CLI subcommand launched under
// the app's own runtime (process.execPath + ELECTRON_RUN_AS_NODE=1), so it needs
// no node/skipper on PATH — mirroring the memory-MCP launch trick.

export interface RunConfinement {
  /** Absolute run root — the agent's cwd (a worktree). Writes are scoped here. */
  runRoot: string;
  /** Absolute paths the run must NEVER touch (the linked repo checkout). */
  denyRoots: string[];
  /** Packaged CLI bundle (skipper.bundle.cjs) hosting the guard subcommand; when
   *  absent the guard hook is omitted (L1 scoping + the tripwire still apply). */
  cliBundlePath?: string;
}

/**
 * Normalize an absolute path into a claude tool-permission root: resolve, drop
 * any trailing separator, force forward slashes, strip leading slashes, prefix
 * `//`. Shape verified against claude CLI 2.1.217 — `Write(//abs/root/**)`.
 */
export function toClaudePathRoot(abs: string): string {
  const forward = resolve(abs).replace(/\\/g, "/").replace(/\/+$/, "");
  return `//${forward.replace(/^\/+/, "")}`;
}

/** Edit/Write rules that pre-approve writes only inside the run root. */
export function scopedWriteRules(runRoot: string): string[] {
  const root = toClaudePathRoot(runRoot);
  return [`Edit(${root}/**)`, `Write(${root}/**)`];
}

function quote(value: string): string {
  return `"${value}"`;
}

/**
 * The `--settings` arg carrying a PreToolUse guard hook. One command handles both
 * matchers (it branches on tool_name from stdin): Edit|Write checks file_path is
 * inside the run root, Bash checks the command text doesn't reference a deny root.
 * Returns [] when there is no CLI bundle to launch the guard from — the caller
 * still gets L1 scoping and the post-run tripwire.
 */
export function buildConfinementSettingsArgs(conf: RunConfinement): string[] {
  if (!conf.cliBundlePath) return [];
  const command = [
    quote(process.execPath),
    quote(conf.cliBundlePath),
    "guard",
    "--root",
    quote(conf.runRoot),
    ...conf.denyRoots.flatMap((root) => ["--deny", quote(root)]),
  ].join(" ");
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write", hooks: [{ type: "command", command }] },
        { matcher: "Bash", hooks: [{ type: "command", command }] },
      ],
    },
  };
  return ["--settings", JSON.stringify(settings)];
}

/**
 * Spawn env for a confined run: the guard hook launches process.execPath as node,
 * so ELECTRON_RUN_AS_NODE=1 must be in the claude process env (hooks inherit it).
 * Harmless for a real claude binary — the flag only affects Electron executables.
 * Falls through to the base env untouched when there is no guard to launch.
 */
export function confinementEnv(
  conf: RunConfinement | undefined,
  baseEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!conf?.cliBundlePath) return baseEnv;
  return { ...(baseEnv ?? process.env), ELECTRON_RUN_AS_NODE: "1" };
}
