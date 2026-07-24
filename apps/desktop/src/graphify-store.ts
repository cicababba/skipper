// Per-repo Graphify index state on disk (#233), one directory per repo under
// <userData>/graphs/<fileKey>/: status.json (the GraphifyDoc) beside
// graphify-out/graph.json (the extracted graph) and wt/ (the ephemeral extract
// worktree). Pure Node module (no electron import) so it stays unit-testable;
// callers inject the graphs directory. Mirrors repo-instructions' per-entity JSON
// pattern (sanitized dir name + tmp+rename + save queue + in-memory running set).

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GraphifyDoc } from "@skipper/shared";

/** repoKey contains "/" which is illegal on Windows filenames — same sanitize as
 *  instructionsFileName, so the two stores derive matching per-repo keys. */
export function graphifyFileKey(repoKey: string): string {
  return repoKey.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function graphifyRepoDir(graphsDir: string, repoKey: string): string {
  return join(graphsDir, graphifyFileKey(repoKey));
}

export function graphPathFor(graphsDir: string, repoKey: string): string {
  return join(graphifyRepoDir(graphsDir, repoKey), "graphify-out", "graph.json");
}

function docPath(graphsDir: string, repoKey: string): string {
  return join(graphifyRepoDir(graphsDir, repoKey), "status.json");
}

const saveQueue = new Map<string, Promise<void>>();

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf-8");
  await rename(tmp, path);
}

async function writeDocFile(path: string, doc: GraphifyDoc): Promise<void> {
  const bytes = JSON.stringify(doc, null, 2);
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

async function readDocFile(path: string): Promise<GraphifyDoc | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as GraphifyDoc;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function loadGraphifyDoc(graphsDir: string, repoKey: string): Promise<GraphifyDoc | null> {
  return readDocFile(docPath(graphsDir, repoKey));
}

export function saveGraphifyDoc(
  graphsDir: string,
  repoKey: string,
  doc: GraphifyDoc,
): Promise<void> {
  return writeDocFile(docPath(graphsDir, repoKey), doc);
}

// In-process truth for "an index run is in flight" (#233): the gate reads this,
// never disk, so a crash can't leave a repo gated forever (markStaleGraphifyRuns
// clears any on-disk installing/indexing at startup).
const running = new Set<string>();

export function isGraphifyRunning(repoKey: string): boolean {
  return running.has(repoKey);
}

export function markGraphifyRunning(repoKey: string): void {
  running.add(repoKey);
}

export function clearGraphifyRunning(repoKey: string): void {
  running.delete(repoKey);
}

/**
 * Flip any on-disk installing/indexing doc to "failed" (#233): the in-flight set
 * never survives a restart, so a doc left mid-run by a crash would gate a repo
 * forever. Best-effort — a missing directory or unreadable file is skipped.
 */
export async function markStaleGraphifyRuns(graphsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(graphsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(graphsDir, entry, "status.json");
    const doc = await readDocFile(path);
    if (!doc || (doc.status !== "installing" && doc.status !== "indexing")) continue;
    await writeDocFile(path, {
      ...doc,
      status: "failed",
      error: "indexing interrupted by app restart",
      updatedAt: new Date().toISOString(),
      runStartedAt: undefined,
    });
  }
}

/**
 * The last-good-graph read path (#233): a usable graph is one whose doc records
 * an indexedSha AND whose graph.json exists on disk — deliberately NOT gated on
 * status === "ready", so a later failed re-index never hides the previous good
 * graph (status gates only the UI).
 */
export async function readReadyGraph(
  graphsDir: string,
  repoKey: string,
): Promise<{ indexedSha: string; graphPath: string } | undefined> {
  const doc = await loadGraphifyDoc(graphsDir, repoKey);
  if (!doc?.indexedSha) return undefined;
  const graphPath = graphPathFor(graphsDir, repoKey);
  if (!existsSync(graphPath)) return undefined;
  return { indexedSha: doc.indexedSha, graphPath };
}
