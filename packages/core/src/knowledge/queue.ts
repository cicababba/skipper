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
// "accepted" lives under .skipper/raw/projects/<project>/ — the curated
// per-project archive the solutions memory builds on. "rejected" is kept
// (not deleted) so the user can re-pickup if they change their mind.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomFilename, parseAtom, serializeAtom, type KnowledgeAtom } from "./atom";

export interface QueuePaths {
  pending: string;
  rejected: string;
  /** Where accepted atoms land — under raw/projects/<project>/. */
  acceptedRoot: string;
}

/**
 * Resolve the queue paths for a Skipper workspace.
 * `workspacePath` is the user's Skipper root (the dir that holds .skipper).
 */
export function queuePaths(workspacePath: string): QueuePaths {
  const dot = join(workspacePath, ".skipper");
  return {
    pending: join(dot, "knowledge-pending"),
    rejected: join(dot, "knowledge-rejected"),
    acceptedRoot: join(dot, "raw", "projects"),
  };
}

/** Ensure all queue dirs exist. Idempotent. */
export async function ensureQueueDirs(workspacePath: string): Promise<QueuePaths> {
  const p = queuePaths(workspacePath);
  await Promise.all([
    mkdir(p.pending, { recursive: true }),
    mkdir(p.rejected, { recursive: true }),
    mkdir(p.acceptedRoot, { recursive: true }),
  ]);
  return p;
}

/** Write a freshly extracted atom into the pending queue. Returns its path. */
export async function writePendingAtom(
  workspacePath: string,
  atom: KnowledgeAtom,
): Promise<string> {
  const p = await ensureQueueDirs(workspacePath);
  const file = join(p.pending, atomFilename(atom));
  await writeFile(file, serializeAtom(atom), "utf-8");
  return file;
}

export interface PendingEntry {
  filePath: string;
  atom: KnowledgeAtom;
}

/** List every readable atom in the pending queue, sorted by score desc, then date desc. */
export async function listPending(workspacePath: string): Promise<PendingEntry[]> {
  const p = queuePaths(workspacePath);
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
  workspacePath: string,
  entry: PendingEntry,
): Promise<string> {
  const p = await ensureQueueDirs(workspacePath);
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
  workspacePath: string,
  entry: PendingEntry,
): Promise<string> {
  const p = await ensureQueueDirs(workspacePath);
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
