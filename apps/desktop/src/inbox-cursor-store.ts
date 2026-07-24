// Per-account issue-source poll cursors, persisted as plain JSON in userData.
// Cursor payloads are opaque adapter state — persisted verbatim, never inspected.
// Pure Node module (no electron import) so it stays unit-testable; the
// poller injects the file path.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { IssueSourceId } from "@skipper/shared";

export interface InboxCursorFile {
  version: 2;
  /** issue source → accountId → opaque adapter cursor. Field name predates the two-axis split (#71). */
  platforms: Partial<Record<IssueSourceId, Record<string, unknown>>>;
}

function freshCursorFile(): InboxCursorFile {
  return { version: 2, platforms: {} };
}

/** Pure parse + v1→v2 migration. Null = unrecognized shape (caller starts fresh). */
export function parseCursorFile(json: string): { file: InboxCursorFile; migrated: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version === 2 && typeof obj.platforms === "object" && obj.platforms !== null) {
    return { file: parsed as InboxCursorFile, migrated: false };
  }
  // Legacy v1 was GitHub-only: { version: 1, github: Record<accountId, cursor> }.
  if (obj.version === 1 && typeof obj.github === "object" && obj.github !== null) {
    return {
      file: { version: 2, platforms: { github: obj.github as Record<string, unknown> } },
      migrated: true,
    };
  }
  return null;
}

export async function loadCursors(filePath: string): Promise<InboxCursorFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return freshCursorFile();
  }
  const parsed = parseCursorFile(raw);
  if (!parsed) return freshCursorFile();
  if (parsed.migrated) await saveCursors(filePath, parsed.file);
  return parsed.file;
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
