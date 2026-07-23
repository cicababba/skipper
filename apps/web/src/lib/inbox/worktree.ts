import type { WorktreeFileChange, WorktreeStatusResult } from "@skipper/shared";

export function worktreeRelPath(root: string, abs: string): string {
  const r = root.replaceAll("\\", "/");
  return abs.replaceAll("\\", "/").slice(r.length + 1);
}

export function changeForRelPath(
  changes: WorktreeFileChange[],
  rel: string,
): WorktreeFileChange | undefined {
  return changes.find((c) => c.path === rel);
}

/**
 * Dirty paths to surface in the plan rail (#204): non-null only when the status
 * probe succeeded, the worktree is present, and it actually holds uncommitted
 * files. A clean, absent, or unprobed worktree yields null (no indicator).
 */
export function presentDirtyFiles(status: WorktreeStatusResult | null): string[] | null {
  if (!status || !status.ok || !status.present) return null;
  const dirty = status.dirtyFiles;
  return dirty && dirty.length > 0 ? dirty : null;
}
