// Manual memory notes (#255): user-authored knowledge stored in the same
// SolutionRecord shape as captured solutions, so search/curation/deletion all
// work unchanged. Pure — no embedder, no filesystem.

import { randomUUID } from "node:crypto";
import type { RepoRef, SolutionRecord } from "@skipper/shared";

const TITLE_MAX = 80;

function deriveTitle(body: string): string {
  const firstLine = body.trim().split("\n")[0] ?? "";
  return firstLine.slice(0, TITLE_MAX);
}

export function createNoteRecord(
  repo: RepoRef,
  body: string,
  files?: string[],
  title?: string,
): SolutionRecord {
  return {
    version: 1,
    itemId: `note:${randomUUID()}`,
    repo,
    title: title?.trim() || deriveTitle(body),
    url: "",
    capturedAt: new Date().toISOString(),
    kind: "note",
    note: files && files.length > 0 ? { body, files } : { body },
  };
}
