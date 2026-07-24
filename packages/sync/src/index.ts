// Orchestrator seams kept from the retired Drive-sync product (#2):
// the pluggable remote-backend contract + pure three-way reconcile logic,
// and the local manifest that tracks per-file state between cycles.
export { diffFiles } from "./backend";
export type {
  SyncBackend,
  RemoteManifest,
  RemoteFileEntry,
  RemoteWorkspace,
  FileMap,
  CommitResult,
  SyncAction,
} from "./backend";
export { loadOrCreateManifest, saveManifest, manifestPath } from "./manifest";
export type { Manifest, ManifestFileEntry } from "./types";
