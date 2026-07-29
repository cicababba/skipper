// Saved composer drafts (#138), one JSON file per draft under <userData>/drafts/.
// Pure Node module (no electron import) so it stays unit-testable; callers inject
// the directory. Mirrors repo-instructions' per-entity JSON pattern (sanitized
// filename + tmp+rename + save queue).

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ComposerDraftListItem, StoredComposerDraft } from "@skipper/shared";

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

async function readDraftPath(path: string): Promise<StoredComposerDraft | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as StoredComposerDraft;
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
    });
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
