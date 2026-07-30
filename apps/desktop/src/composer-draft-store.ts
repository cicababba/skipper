// Saved composer drafts (#138), one JSON file per draft under <userData>/drafts/.
// Pure Node module (no electron import) so it stays unit-testable; callers inject
// the directory. Mirrors repo-instructions' per-entity JSON pattern (sanitized
// filename + tmp+rename + save queue).

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repoKey, type ComposerDraftListItem, type StoredComposerDraft } from "@skipper/shared";

/** A draft id is a UUID today, but the file name is sanitized all the same. */
export function draftFileName(draftId: string): string {
  return `${draftId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export function draftFilePath(dir: string, draftId: string): string {
  return join(dir, draftFileName(draftId));
}

// Serialized saves so an autosave landing on top of an explicit save never races
// the write+rename.
const saveQueue = new Map<string, Promise<void>>();

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf-8");
  await rename(tmp, path);
}

export async function saveComposerDraftFile(dir: string, draft: StoredComposerDraft): Promise<void> {
  const path = draftFilePath(dir, draft.draftId);
  const bytes = JSON.stringify(draft, null, 2);
  const prev = saveQueue.get(path) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* swallow previous error so this save still runs */
    })
    .then(() => writeAtomic(path, bytes));
  saveQueue.set(path, next);
  try {
    await next;
  } finally {
    if (saveQueue.get(path) === next) saveQueue.delete(path);
  }
}

/** The quit path (#272) writes outside the save queue on purpose: `before-quit`
 *  cannot await, and by then nothing else is writing drafts. */
export function saveComposerDraftFileSync(dir: string, draft: StoredComposerDraft): void {
  const path = draftFilePath(dir, draft.draftId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(draft, null, 2), "utf-8");
  renameSync(tmp, path);
}

async function readDraftPath(path: string): Promise<StoredComposerDraft | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as StoredComposerDraft;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function readDraftPathSync(path: string): StoredComposerDraft | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as StoredComposerDraft;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function readComposerDraftFile(
  dir: string,
  draftId: string,
): Promise<StoredComposerDraft | null> {
  return readDraftPath(draftFilePath(dir, draftId));
}

export async function deleteComposerDraftFile(dir: string, draftId: string): Promise<boolean> {
  try {
    await unlink(draftFilePath(dir, draftId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep at most one unfinished draft per repo (#272): drop every other unfinished
 * file of `repoKeyStr` except `keepIds` (the one just written, plus the drafts
 * live records still hold). Explicit drafts are never touched.
 */
export async function deleteUnfinishedDraftFiles(
  dir: string,
  repoKeyStr: string,
  keepIds: Set<string>,
  onDeleted?: (draft: StoredComposerDraft) => void,
): Promise<boolean> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return false;
  }
  let deleted = false;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const draft = await readDraftPath(path);
    if (!draft?.unfinished) continue;
    if (keepIds.has(draft.draftId) || repoKey(draft.repo) !== repoKeyStr) continue;
    try {
      await unlink(path);
      deleted = true;
      onDeleted?.(draft);
    } catch {
      /* a file that cannot be removed stays listed — the next capture retries */
    }
  }
  return deleted;
}

export function deleteUnfinishedDraftFilesSync(
  dir: string,
  repoKeyStr: string,
  keepIds: Set<string>,
  onDeleted?: (draft: StoredComposerDraft) => void,
): boolean {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return false;
  }
  let deleted = false;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const draft = readDraftPathSync(path);
    if (!draft?.unfinished) continue;
    if (keepIds.has(draft.draftId) || repoKey(draft.repo) !== repoKeyStr) continue;
    try {
      unlinkSync(path);
      deleted = true;
      onDeleted?.(draft);
    } catch {
      /* same as the async twin: best-effort */
    }
  }
  return deleted;
}

/** Chat ids of every stored draft — the attachment sweep's keep-set (#281). */
export async function listComposerDraftChatIds(dir: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const draft = await readDraftPath(join(dir, file));
    if (draft) ids.push(draft.chatId);
  }
  return ids;
}

/** Most recently touched first — the list is a resume surface, not an archive. */
export async function listComposerDrafts(dir: string): Promise<ComposerDraftListItem[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const items: ComposerDraftListItem[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const draft = await readDraftPath(join(dir, file));
    if (!draft) continue;
    items.push({
      draftId: draft.draftId,
      repo: draft.repo,
      title: draft.title,
      updatedAt: draft.updatedAt,
      ...(draft.unfinished ? { unfinished: true } : {}),
      ...(draft.messages.length === 0 ? { quick: true } : {}),
    });
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
