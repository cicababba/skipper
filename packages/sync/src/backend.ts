/**
 * Pluggable remote sync backend — the open-core seam.
 *
 * The GPL core defines this contract and the (pure, network-free) reconcile
 * logic. A backend implementation — e.g. the proprietary Skipper Enterprise
 * "Team Server" adapter — provides the actual transport. This keeps the
 * *interface* open (anyone can target a backend) while the Enterprise server,
 * its HTTP client, end-to-end encryption and licensing stay proprietary.
 *
 * Model (vs. the Drive adapter's file-id + changes feed): a workspace is a
 * versioned **manifest** (path → content hash) plus a set of content-addressed
 * **blobs**. Commits use optimistic concurrency; conflicts are reconciled
 * client-side with the union / keep-both rules below.
 */

/** One file in a remote manifest: content hash + size + mtime (unix seconds). */
export interface RemoteFileEntry {
  hash: string;
  size: number;
  mtime: number;
}

/** A path → entry map (the body of a manifest, and of a local snapshot). */
export type FileMap = Record<string, RemoteFileEntry>;

/** A versioned snapshot of a workspace's files. */
export interface RemoteManifest {
  version: number;
  files: FileMap;
}

export interface RemoteWorkspace {
  id: string;
  name: string;
  /** Org-wide knowledge everyone can access (vs a restricted Nest). */
  isGlobal?: boolean;
  /** Caller's effective role: writers contribute, readers are pull-only. */
  role?: "writer" | "reader";
}

/** Outcome of a commit: accepted (new head) or rejected (stale base). */
export type CommitResult =
  | { ok: true; manifest: RemoteManifest }
  | { ok: false; conflict: true; manifest: RemoteManifest };

/**
 * A pluggable, authenticated sync backend. Auth/session is the adapter's own
 * concern — every method assumes the backend is already authenticated.
 */
export interface SyncBackend {
  /** Stable backend identifier, e.g. "team-server". */
  readonly id: string;

  listWorkspaces(): Promise<RemoteWorkspace[]>;
  getManifest(workspaceId: string): Promise<RemoteManifest>;

  /** Optional fast-path so the client can skip re-uploading existing blobs. */
  hasBlob?(workspaceId: string, hash: string): Promise<boolean>;
  putBlob(workspaceId: string, hash: string, bytes: Uint8Array): Promise<void>;
  getBlob(workspaceId: string, hash: string): Promise<Uint8Array>;

  /**
   * Commit a new manifest. Must be based on the current head `version`; if a
   * peer committed first the backend rejects with `{ ok:false, conflict:true,
   * manifest }` and the caller reconciles + retries.
   */
  commit(workspaceId: string, baseVersion: number, files: FileMap): Promise<CommitResult>;
}

/** One reconciliation step the sync flow must carry out for a path. */
export interface SyncAction {
  path: string;
  /**
   * - `upload`        local version wins → push blob + keep in the commit
   * - `download`      remote version wins → write locally
   * - `keep-both`     both sides changed → keep local, write remote as a
   *                   `<path>.conflict-<ts>` sibling; both go into the commit
   * - `delete-local`  remote deleted an otherwise-unchanged file → remove locally
   * - `delete-remote` local deleted an otherwise-unchanged file → drop from commit
   */
  action: "upload" | "download" | "keep-both" | "delete-local" | "delete-remote";
}

function hashOf(map: FileMap, path: string): string | undefined {
  return map[path]?.hash;
}

/**
 * Three-way, union-safe reconcile between the last-synced `base`, the current
 * `local` snapshot, and the current `remote` manifest. Pure: no I/O.
 *
 * Union-safe means a delete on one side never destroys an edit on the other —
 * the edit is resurrected — and simultaneous edits become keep-both. This
 * mirrors the Drive engine's existing semantics, applied to the manifest model.
 */
export function diffFiles(base: FileMap, local: FileMap, remote: FileMap): SyncAction[] {
  const actions: SyncAction[] = [];
  const paths = new Set<string>([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const path of paths) {
    const b = hashOf(base, path);
    const l = hashOf(local, path);
    const r = hashOf(remote, path);

    if (l === r) continue; // already in sync (both present & equal, or both absent)

    if (l !== undefined && r !== undefined) {
      // Present on both sides, differing content.
      if (b === l) actions.push({ path, action: "download" }); // only remote changed
      else if (b === r) actions.push({ path, action: "upload" }); // only local changed
      else actions.push({ path, action: "keep-both" }); // both changed
    } else if (l !== undefined) {
      // Missing remotely.
      if (b === l) actions.push({ path, action: "delete-local" }); // remote deleted, local untouched
      else actions.push({ path, action: "upload" }); // local new/edited (resurrect remotely)
    } else {
      // Missing locally.
      if (b === r) actions.push({ path, action: "delete-remote" }); // local deleted, remote untouched
      else actions.push({ path, action: "download" }); // remote new/edited (resurrect locally)
    }
  }

  return actions;
}
