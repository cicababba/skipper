// Per-account GitHub poll cursors, persisted as plain JSON in userData.
// Pure Node module (no electron import) so it stays unit-testable; the
// poller injects the file path.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { GitHubAccountCursor } from "@nestbrain/core";

export interface InboxCursorFile {
  version: 1;
  /** accountId → cursor */
  github: Record<string, GitHubAccountCursor>;
}

function freshCursorFile(): InboxCursorFile {
  return { version: 1, github: {} };
}

export async function loadCursors(filePath: string): Promise<InboxCursorFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as InboxCursorFile;
    if (parsed.version === 1 && typeof parsed.github === "object" && parsed.github !== null) {
      return parsed;
    }
    return freshCursorFile();
  } catch {
    return freshCursorFile();
  }
}

// Serialized saves so concurrent poll ticks never race the write+rename.
const saveQueue = new Map<string, Promise<void>>();

export async function saveCursors(filePath: string, cursors: InboxCursorFile): Promise<void> {
  const bytes = JSON.stringify(cursors, null, 2);
  const prev = saveQueue.get(filePath) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* swallow previous error so this save still runs */ })
    .then(() => writeAtomic(filePath, bytes));
  saveQueue.set(filePath, next);
  try {
    await next;
  } finally {
    if (saveQueue.get(filePath) === next) saveQueue.delete(filePath);
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf-8");
  await rename(tmp, path);
}
