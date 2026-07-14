// Git post-commit hook install / detect / uninstall.
//
// The hook fires after every commit on a registered repository and runs
// the knowledge extractor in the background (commit terminal does NOT block).
// Atoms land in <workspace>/.skipper/knowledge-pending/ for later review.
//
// Install is append-aware: if a non-Skipper post-commit already exists, we
// add our snippet at the end, surrounded by markers so re-install (upgrade)
// rewrites only our portion and uninstall removes only our portion.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Bumped when we change the hook body so re-register upgrades the snippet. */
const HOOK_VERSION = 1;
const BEGIN_MARKER = "# >>> skipper knowledge hook (managed) >>>";
const END_MARKER = "# <<< skipper knowledge hook (managed) <<<";

export interface InstallHookOptions {
  repoPath: string;
  /**
   * Command the hook invokes (will be exec'd in background).
   * Examples:
   *   "skipper"                                  ← globally installed
   *   "/abs/path/to/skipper"                     ← explicit binary
   *   "npx tsx /abs/path/packages/cli/src/index.ts" ← dev mode
   */
  cliCommand: string;
}

export interface HookStatus {
  hookPath: string;
  exists: boolean;
  ours: boolean;
  /** Version of our snippet if present, or null. */
  version: number | null;
}

function hooksDir(repoPath: string): string {
  // Honors core.hooksPath if configured, and falls back to .git/hooks.
  const out = execFileSync("git", ["-C", repoPath, "rev-parse", "--git-path", "hooks"], {
    encoding: "utf-8",
  }).trim();
  // git rev-parse returns the path relative to the working dir; resolve.
  if (out.startsWith("/")) return out;
  return join(repoPath, out);
}

function postCommitPath(repoPath: string): string {
  return join(hooksDir(repoPath), "post-commit");
}

export function getHookStatus(repoPath: string): HookStatus {
  const hookPath = postCommitPath(repoPath);
  if (!existsSync(hookPath)) {
    return { hookPath, exists: false, ours: false, version: null };
  }
  const contents = readFileSync(hookPath, "utf-8");
  const match = /# skipper-knowledge-hook:(\d+)/.exec(contents);
  return {
    hookPath,
    exists: true,
    ours: contents.includes(BEGIN_MARKER),
    version: match ? Number(match[1]) : null,
  };
}

function buildHookSnippet(cliCommand: string): string {
  // Single-quoted JS-style: escape backslashes & single quotes for shell literal.
  const safe = cliCommand.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
  return [
    BEGIN_MARKER,
    `# skipper-knowledge-hook:${HOOK_VERSION}`,
    "# Extracts knowledge atoms from the latest commit into <workspace>/.skipper/",
    "# knowledge-pending/ for later review. Runs detached — does NOT block the commit.",
    `skipper_cli='${safe}'`,
    "skipper_repo=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
    "skipper_workspace=''",
    "skipper_dir=\"$skipper_repo\"",
    "skipper_i=0",
    "while [ \"$skipper_i\" -lt 20 ]; do",
    "  if [ -d \"$skipper_dir/.skipper\" ]; then",
    "    skipper_workspace=\"$skipper_dir\"",
    "    break",
    "  fi",
    "  skipper_parent=$(dirname \"$skipper_dir\")",
    "  [ \"$skipper_parent\" = \"$skipper_dir\" ] && break",
    "  skipper_dir=\"$skipper_parent\"",
    "  skipper_i=$((skipper_i + 1))",
    "done",
    "[ -z \"$skipper_workspace\" ] && exit 0",
    "skipper_sha=$(git rev-parse HEAD)",
    "skipper_log_dir=\"$skipper_workspace/.skipper/knowledge-log\"",
    "mkdir -p \"$skipper_log_dir\"",
    "{",
    "  echo \"--- $(date -u +%Y-%m-%dT%H:%M:%SZ) commit $skipper_sha ---\"",
    "  eval \"$skipper_cli knowledge extract \\\"$skipper_sha\\\" --repo \\\"$skipper_repo\\\" --workspace \\\"$skipper_workspace\\\"\"",
    "} >> \"$skipper_log_dir/extract.log\" 2>&1 </dev/null &",
    "disown 2>/dev/null || true",
    END_MARKER,
    "",
  ].join("\n");
}

export function installHook(opts: InstallHookOptions): { hookPath: string; replaced: boolean } {
  const hookPath = postCommitPath(opts.repoPath);
  const snippet = buildHookSnippet(opts.cliCommand);
  const shebang = "#!/bin/sh\n";

  if (!existsSync(hookPath)) {
    writeFileSync(hookPath, shebang + "\n" + snippet, "utf-8");
    chmodSync(hookPath, 0o755);
    return { hookPath, replaced: false };
  }

  const current = readFileSync(hookPath, "utf-8");
  const beginIdx = current.indexOf(BEGIN_MARKER);
  if (beginIdx >= 0) {
    // Upgrade in place: replace from begin to (end + newline).
    const endIdx = current.indexOf(END_MARKER, beginIdx);
    const endOfBlock = endIdx >= 0 ? current.indexOf("\n", endIdx + END_MARKER.length) + 1 : current.length;
    const before = current.slice(0, beginIdx);
    const after = endIdx >= 0 ? current.slice(endOfBlock) : "";
    writeFileSync(hookPath, before + snippet + after, "utf-8");
    chmodSync(hookPath, 0o755);
    return { hookPath, replaced: true };
  }

  // Append to an existing foreign hook. Make sure there's a trailing newline.
  const sep = current.endsWith("\n") ? "" : "\n";
  writeFileSync(hookPath, current + sep + "\n" + snippet, "utf-8");
  chmodSync(hookPath, 0o755);
  return { hookPath, replaced: false };
}

export function uninstallHook(repoPath: string): { hookPath: string; removed: boolean } {
  const hookPath = postCommitPath(repoPath);
  if (!existsSync(hookPath)) return { hookPath, removed: false };
  const current = readFileSync(hookPath, "utf-8");
  const beginIdx = current.indexOf(BEGIN_MARKER);
  if (beginIdx < 0) return { hookPath, removed: false };
  const endIdx = current.indexOf(END_MARKER, beginIdx);
  const endOfBlock = endIdx >= 0 ? current.indexOf("\n", endIdx + END_MARKER.length) + 1 : current.length;
  const before = current.slice(0, beginIdx).replace(/\n+$/, "\n");
  const after = endIdx >= 0 ? current.slice(endOfBlock) : "";
  const next = before + after;
  // If we'd be left with just "#!/bin/sh\n" or empty, leave the file in place
  // but cleaned — don't remove the file (other tooling may still expect it).
  writeFileSync(hookPath, next, "utf-8");
  return { hookPath, removed: true };
}
