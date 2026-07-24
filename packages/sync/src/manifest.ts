// Manifest persistence.
//
// Lives at <workspace>/.skipper/sync-manifest.json. Records the device
// identity, the Drive folder ids we've cached, and per-file hash/driveId
// so the next sync cycle can diff cheaply without hashing every file twice.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Manifest } from "./types";

const MANIFEST_RELPATH = ".skipper/sync-manifest.json";

export function manifestPath(workspacePath: string): string {
  return join(workspacePath, MANIFEST_RELPATH);
}

export async function loadOrCreateManifest(workspacePath: string): Promise<Manifest> {
  const path = manifestPath(workspacePath);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.version === 1) return parsed;
    // Unknown version → start fresh, keep the device id if we can recover one.
    return freshManifest();
  } catch {
    return freshManifest();
  }
}

// Per-path save queue. Multiple concurrent callers (engine + softDelete +
// hardDelete + watcher-triggered push) all funnel here; we serialize so
// the write+rename sequence is never raced.
const saveQueue = new Map<string, Promise<void>>();

export async function saveManifest(workspacePath: string, manifest: Manifest): Promise<void> {
  const path = manifestPath(workspacePath);
  // Snapshot the manifest synchronously so subsequent mutations by the caller
  // don't change the bytes we're about to write.
  const bytes = JSON.stringify(manifest, null, 2);

  const prev = saveQueue.get(path) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* swallow previous error so this save still runs */ })
    .then(() => writeAtomic(path, bytes));
  saveQueue.set(path, next);
  try {
    await next;
  } finally {
    if (saveQueue.get(path) === next) saveQueue.delete(path);
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

function freshManifest(): Manifest {
  return {
    version: 1,
    deviceId: randomUUID(),
    deviceName: hostname() || "Unknown device",
    folders: {},
    files: {},
  };
}
