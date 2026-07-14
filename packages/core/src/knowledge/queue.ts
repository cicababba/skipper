// Filesystem operations for the knowledge atom queue.
//
// State machine on disk:
//
//   pending   ← extractor writes here
//      │
//   ┌──┴──┐
//   ▼     ▼
// accepted  rejected
//
// "accepted" lives under <knowledgeRoot>/accepted/<project>/ — the curated
// per-project archive the solutions memory builds on. "rejected" is kept
// (not deleted) so the user can re-pickup if they change their mind.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomFilename, parseAtom, serializeAtom, type KnowledgeAtom } from "./atom";

export interface QueuePaths {
  pending: string;
  rejected: string;
  /** Where accepted atoms land — under accepted/<project>/. */
  acceptedRoot: string;
}

/**
 * Resolve the queue paths under the knowledge root
 * (the app's `<userData>/knowledge/` directory).
 */
export function queuePaths(knowledgeRoot: string): QueuePaths {
  return {
    pending: join(knowledgeRoot, "pending"),
    rejected: join(knowledgeRoot, "rejected"),
    acceptedRoot: join(knowledgeRoot, "accepted"),
  };
}

/** Ensure all queue dirs exist. Idempotent. */
export async function ensureQueueDirs(knowledgeRoot: string): Promise<QueuePaths> {
  const p = queuePaths(knowledgeRoot);
  await Promise.all([
    mkdir(p.pending, { recursive: true }),
    mkdir(p.rejected, { recursive: true }),
    mkdir(p.acceptedRoot, { recursive: true }),
  ]);
  return p;
}

/** Write a freshly extracted atom into the pending queue. Returns its path. */
export async function writePendingAtom(
  knowledgeRoot: string,
  atom: KnowledgeAtom,
): Promise<string> {
  const p = await ensureQueueDirs(knowledgeRoot);
  const file = join(p.pending, atomFilename(atom));
  await writeFile(file, serializeAtom(atom), "utf-8");
  return file;
}

export interface PendingEntry {
  filePath: string;
  atom: KnowledgeAtom;
}

/** List every readable atom in the pending queue, sorted by score desc, then date desc. */
export async function listPending(knowledgeRoot: string): Promise<PendingEntry[]> {
  const p = queuePaths(knowledgeRoot);
  let names: string[];
  try {
    names = await readdir(p.pending);
  } catch {
    return [];
  }
  const out: PendingEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const full = join(p.pending, name);
    try {
      const text = await readFile(full, "utf-8");
      const atom = parseAtom(text);
      if (atom) out.push({ filePath: full, atom });
    } catch {
      // Unreadable file — skip silently.
    }
  }
  out.sort((a, b) => {
    if (b.atom.score !== a.atom.score) return b.atom.score - a.atom.score;
    return b.atom.created.localeCompare(a.atom.created);
  });
  return out;
}

/**
 * Move a pending atom into the project's accepted bucket so the next compile
 * picks it up. Returns the destination path.
 */
export async function acceptAtom(
  knowledgeRoot: string,
  entry: PendingEntry,
): Promise<string> {
  const p = await ensureQueueDirs(knowledgeRoot);
  const projectDir = join(p.acceptedRoot, entry.atom.project);
  await mkdir(projectDir, { recursive: true });
  const dest = join(projectDir, atomFilename(entry.atom));
  await rename(entry.filePath, dest);
  return dest;
}

/**
 * Move a pending atom into the rejected bucket. Kept (not deleted) so the
 * user can resurrect it later if they change their mind.
 */
export async function rejectAtom(
  knowledgeRoot: string,
  entry: PendingEntry,
): Promise<string> {
  const p = await ensureQueueDirs(knowledgeRoot);
  const dest = join(p.rejected, atomFilename(entry.atom));
  await rename(entry.filePath, dest);
  return dest;
}

/**
 * Overwrite a pending atom with edited content (e.g. the user tweaked the
 * title/body before accepting). Renames the file if the slug changed.
 */
export async function updatePendingAtom(
  oldPath: string,
  updated: KnowledgeAtom,
): Promise<string> {
  const dir = oldPath.slice(0, oldPath.lastIndexOf("/")) || "/";
  const next = join(dir, atomFilename(updated));
  await writeFile(oldPath, serializeAtom(updated), "utf-8");
  if (next !== oldPath) {
    await rename(oldPath, next);
  }
  return next;
}
