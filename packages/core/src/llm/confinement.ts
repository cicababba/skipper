import { posix, win32 } from "node:path";

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
  /** Absolute roots the guard protects in Bash commands — any path token under
   *  one of them that is not inside the run root is blocked. The run root is the
   *  carve-out, so a protect root may legitimately contain it. */
  protectRoots?: string[];
}

/**
 * Normalize an absolute path into a claude tool-permission root: resolve, drop
 * any trailing separator, force forward slashes, strip leading slashes, prefix
 * `//`. Shape verified against claude CLI 2.1.217 on POSIX — `Write(//abs/root/**)`.
 * On Windows no path-scoped Write/Edit rule shape matches at all (upstream bug
 * anthropics/claude-code#67849), which is why `writeApprovalRules` does not use
 * this when the guard hook can enforce the root instead.
 */
export function toClaudePathRoot(
  abs: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const impl = platform === "win32" ? win32 : posix;
  const forward = impl.resolve(abs).replace(/\\/g, "/").replace(/\/+$/, "");
  return `//${forward.replace(/^\/+/, "")}`;
}

/** Edit/Write rules that pre-approve writes only inside the run root. */
export function scopedWriteRules(
  runRoot: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const root = toClaudePathRoot(runRoot, platform);
  return [`Edit(${root}/**)`, `Write(${root}/**)`];
}

/**
 * The Edit/Write entries for `--allowedTools`. On POSIX the path-scoped rules are
 * the enforcement. On Windows the CLI's matcher rejects every drive-letter rule
 * shape (anthropics/claude-code#67849), so scoped rules there mean "Edit/Write
 * always denied" and the agent falls back to Bash writes: with the guard hook
 * available we grant the bare tools and let it enforce the run root, without it
 * we keep the non-matching scoped rules rather than granting unguarded writes.
 */
export function writeApprovalRules(
  runRoot: string,
  guarded: boolean,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32" && guarded) return ["Edit", "Write"];
  return scopedWriteRules(runRoot, platform);
}

function quote(value: string): string {
  return `"${value}"`;
}

/**
 * The `--settings` arg carrying a PreToolUse guard hook. One command handles both
 * matchers (it branches on tool_name from stdin): Edit|Write checks file_path is
 * inside the run root, Bash checks the command text doesn't reference a deny root
 * or reach outside the run root inside a protect root.
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
    ...(conf.protectRoots ?? []).flatMap((root) => ["--protect", quote(root)]),
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
