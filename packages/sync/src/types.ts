// Manifest types — the local per-device record of file state between sync
// cycles. Kept as an orchestrator seam (#2); the Drive-specific fields date
// from the retired Drive engine and will evolve with the new backends.

export interface ManifestFileEntry {
  /**
   * Hex-encoded MD5 of the file contents at last successful sync.
   * MD5 is used here purely because Drive exposes md5Checksum on file
   * metadata, letting us compare local vs remote without downloading.
   */
  md5: string;
  /** Drive file id (alphanumeric, ~33 chars). */
  driveId: string;
  /** Local mtime in ms-epoch at last sync. */
  mtime: number;
  /** Local size in bytes at last sync. */
  size: number;
}

export interface Manifest {
  /** Schema version; bump on breaking changes. */
  version: 1;
  /** UUID v4 generated once per machine on first sync. */
  deviceId: string;
  /** Human-readable label (os.hostname() at creation time). */
  deviceName: string;
  /** Drive folder id of the NestBrain-Sync root. */
  rootFolderDriveId?: string;
  /** Map of relative folder path → Drive folder id. Root has key "". */
  folders: Record<string, string>;
  /** Map of POSIX-style relative path → entry. */
  files: Record<string, ManifestFileEntry>;
  /** ms-epoch of last successful sync. */
  lastSyncAt?: number;
  /**
   * Drive change-log page token. Present after the first successful pull;
   * used by listChanges() to return only what changed remotely since the
   * previous sync. Absent → next pull does a full Drive walk and re-seeds
   * the token. Tokens older than ~30 days are invalidated by Google and we
   * fall back to a full walk on the next "invalid token" error.
   */
  driveChangesPageToken?: string;
}
