import { resolve, sep } from "node:path";

/**
 * Resolve `targetPath` and assert it is `root` itself or nested inside it.
 * The editor's read/write/mutate fs handlers gate on this so a compromised
 * preload cannot touch files outside the worktrees root. Directory *listing*
 * (skipper:fs:list) is deliberately not gated — the repo file-tree browses
 * checkouts that live outside the worktrees root.
 */
export function assertInsideWorktrees(targetPath: string, root: string): string {
  const abs = resolve(targetPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`Refusing to access path outside the worktrees root: ${abs}`);
  }
  return abs;
}

/** Cheap heuristic: a null byte in the first 8KB means the buffer is binary. */
export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
