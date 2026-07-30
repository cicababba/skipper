import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

// PreToolUse guard hook (#196), layer 2. Invoked by the claude CLI before every
// Edit/Write/Bash tool call during a confined run, launched as
// `process.execPath <skipper.bundle.cjs> guard --root <runRoot> --deny <checkout>
// [--protect <home>]`.
// It reads the hook payload from stdin and exits 2 (with a message on stderr the
// model sees) to block a call, or 0 to allow it. Fail-open by contract: any
// parse/shape problem exits 0 so a guard bug can't brick every run — layer 1
// (path-scoped pre-approval) and the post-run tripwire back it up.

export interface GuardHookInput {
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
  cwd?: string;
}

export interface GuardOptions {
  /** Absolute run root — Edit/Write must resolve inside it. */
  root: string;
  /** Absolute deny roots — a Bash command referencing one is blocked. */
  deny: string[];
  /** Absolute protect roots — a Bash command path token under one of them that is
   *  not inside the run root is blocked. The run root itself is the carve-out. */
  protect: string[];
}

export interface GuardVerdict {
  block: boolean;
  message?: string;
}

function normalizeForCompare(p: string): string {
  const forward = p.replace(/\\/g, "/");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

/** Resolve a tool file_path against the hook cwd, following symlinks where the
 *  path (or its parent, for a not-yet-created file) exists so a symlinked
 *  directory can't smuggle a write out of the root; lexical fallback otherwise. */
function resolveFilePath(cwd: string | undefined, filePath: string): string {
  const abs = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(cwd ?? process.cwd(), filePath);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

function isInside(root: string, abs: string): boolean {
  const r = normalizeForCompare(resolve(root).replace(/[/\\]+$/, ""));
  const a = normalizeForCompare(abs);
  return a === r || a.startsWith(`${r}/`);
}

function commandReferencesRoot(command: string, denyRoot: string): boolean {
  const root = normalizeForCompare(resolve(denyRoot).replace(/[/\\]+$/, ""));
  if (!root) return false;
  return normalizeForCompare(command).includes(root);
}

// Shell delimiters that can't be part of a path token, so a path ends at them.
const TOKEN_BOUNDARY = /[\s"'`;|&<>()]/;
const HOME_PREFIXES = ["~/", "$home/", "%userprofile%/"];

function normalizeRoot(root: string): string {
  return normalizeForCompare(root.replace(/[/\\]+$/, ""));
}

/** Containment on already-normalized text — no resolve(), so a win32 literal can
 *  be checked on any host (the Bash branch never touches the filesystem). */
function isInsideNormalized(root: string, candidate: string): boolean {
  const r = normalizeRoot(root);
  const c = normalizeRoot(candidate);
  return c === r || c.startsWith(`${r}/`);
}

function pathTokenAt(command: string, index: number): string {
  const rest = command.slice(index);
  const end = rest.search(TOKEN_BOUNDARY);
  return end === -1 ? rest : rest.slice(0, end);
}

function expandHomePrefix(token: string, homeRoot: string): string | undefined {
  const lower = token.toLowerCase();
  const prefix = HOME_PREFIXES.find((p) => lower.startsWith(p));
  return prefix ? `${homeRoot}/${token.slice(prefix.length)}` : undefined;
}

/** First path token in the command that lands under a protect root — directly or
 *  through a home shorthand — without staying inside the run root. */
function protectEscape(command: string, runRoot: string, protectRoots: string[]): string | undefined {
  const roots = protectRoots.map(normalizeRoot).filter((root) => root !== "");
  if (roots.length === 0) return undefined;
  const text = normalizeForCompare(command);
  const candidates: string[] = [];
  for (const root of roots) {
    for (let i = text.indexOf(root); i !== -1; i = text.indexOf(root, i + root.length)) {
      candidates.push(pathTokenAt(text, i));
    }
  }
  for (const token of text.split(TOKEN_BOUNDARY)) {
    const expanded = token === "" ? undefined : expandHomePrefix(token, roots[0]);
    if (expanded) candidates.push(expanded);
  }
  return candidates.find((candidate) => !isInsideNormalized(runRoot, candidate));
}

/** Pure verdict for a hook payload — extracted for direct testing. */
export function evaluateGuard(input: GuardHookInput, opts: GuardOptions): GuardVerdict {
  const tool = input.tool_name;
  if (tool === "Edit" || tool === "Write") {
    const filePath = input.tool_input?.file_path;
    if (typeof filePath !== "string" || filePath === "") return { block: false };
    const abs = resolveFilePath(input.cwd, filePath);
    if (!isInside(opts.root, abs)) {
      return {
        block: true,
        message: `Skipper confinement: refusing to ${tool} outside the worktree (${opts.root}): ${abs}. Use a relative path inside your working directory.`,
      };
    }
    return { block: false };
  }
  if (tool === "Bash") {
    const command = input.tool_input?.command;
    if (typeof command !== "string" || command === "") return { block: false };
    const hit = opts.deny.find((root) => commandReferencesRoot(command, root));
    if (hit) {
      return {
        block: true,
        message: `Skipper confinement: refusing a Bash command that references the linked checkout (${hit}). Operate only inside your worktree using relative paths.`,
      };
    }
    const escape = protectEscape(command, opts.root, opts.protect);
    if (escape) {
      return {
        block: true,
        message: `Skipper confinement: refusing a Bash command that reaches outside the worktree (${opts.root}): ${escape}. Operate only inside your worktree using relative paths.`,
      };
    }
    return { block: false };
  }
  return { block: false };
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** CLI entry: read the hook payload, evaluate, exit 2 to block or 0 to allow. */
export async function runGuardCommand(opts: GuardOptions): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  let input: GuardHookInput;
  try {
    input = JSON.parse(raw) as GuardHookInput;
  } catch {
    process.exit(0);
  }
  let verdict: GuardVerdict;
  try {
    verdict = evaluateGuard(input, opts);
  } catch {
    process.exit(0);
  }
  if (verdict.block) {
    process.stderr.write(`${verdict.message}\n`);
    process.exit(2);
  }
  process.exit(0);
}
