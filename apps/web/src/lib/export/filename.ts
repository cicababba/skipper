import { slugKey, type RepoRef } from "@skipper/shared";

// Default filename for a markdown export (#216): `<repo>-<key>-<artifact>.md`.

export type ExportArtifact = "dossier" | "plan" | "review" | "worktree";

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function exportFilename(repo: RepoRef, issueKey: string, artifact: ExportArtifact): string {
  return `${sanitize(repo.name)}-${slugKey(issueKey)}-${artifact}.md`;
}
