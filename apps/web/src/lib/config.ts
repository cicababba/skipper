import { resolve } from "node:path";

export function getDataDir(): string {
  if (process.env.SKIPPER_DATA_DIR) {
    return resolve(process.env.SKIPPER_DATA_DIR);
  }
  return resolve(process.cwd(), "../../data");
}

export function getDataPaths() {
  const base = getDataDir();
  // Wiki is persisted in the user-visible Skipper/Library/Knowledge folder
  // when running inside the Electron app. Fall back to $DATA_DIR/wiki for
  // the web/dev mode where no Skipper layout exists.
  const wikiPath = process.env.SKIPPER_WIKI_DIR
    ? resolve(process.env.SKIPPER_WIKI_DIR)
    : resolve(base, "wiki");
  return {
    rawPath: resolve(base, "raw"),
    wikiPath,
  };
}

/**
 * Skipper workspace root — the directory that contains `.skipper/`.
 * Derived from the data dir's parent. The knowledge queue uses this as its
 * anchor because pending/rejected/accepted dirs are siblings of `raw/`.
 */
export function getWorkspacePath(): string {
  return resolve(getDataDir(), "..");
}
