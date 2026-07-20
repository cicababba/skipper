import type { WorktreeFileChange } from "@skipper/shared";

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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

const MAX_LISTED_FILES = 20;

export function buildClaudePrompt(params: {
  keyLabel: string;
  title: string;
  branch: string;
  changedFiles: string[];
}): string {
  const shown = params.changedFiles.slice(0, MAX_LISTED_FILES);
  const extra = params.changedFiles.length - shown.length;
  const title = params.title.replace(/\s+/g, " ").trim();
  return [
    `I'm working on ${params.keyLabel} "${title}" on branch ${params.branch}.`,
    shown.length
      ? `Changed files so far: ${shown.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}.`
      : `No files changed yet.`,
    `Get up to speed on this worktree, then help me continue.`,
  ].join(" ");
}
