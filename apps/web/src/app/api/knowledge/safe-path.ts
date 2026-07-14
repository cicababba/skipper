import { resolve, sep } from "node:path";

/**
 * Reject any filePath that doesn't resolve into the workspace's
 * .skipper/knowledge-pending/ directory. Defends the accept/reject/update
 * routes against path-traversal where a malicious client could otherwise
 * point them at arbitrary files on disk. The boundary check uses the
 * platform separator — a hardcoded "/" made this reject every valid path on
 * Windows (resolve() yields backslashes there).
 */
export function assertSafePendingPath(workspacePath: string, filePath: string): void {
  const pendingRoot = resolve(workspacePath, ".skipper", "knowledge-pending");
  const resolved = resolve(filePath);
  if (resolved !== pendingRoot && !resolved.startsWith(pendingRoot + sep)) {
    throw new Error("filePath must be inside .skipper/knowledge-pending/");
  }
}
