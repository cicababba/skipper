import type { WorktreeFileChange } from "@skipper/shared";

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
