import type { TrackedItem } from "@skipper/shared";
import type { ExportArtifact } from "./filename";

// Export availability per artifact (#216). Stricter than the detail tab's
// tabEnabled on review: data presence only, not lifecycle state.

export function exportAvailable(artifact: ExportArtifact, item: TrackedItem): boolean {
  switch (artifact) {
    case "dossier":
      return true;
    case "plan":
      return item.plan?.ref != null;
    case "review":
      return item.review != null;
    case "worktree":
      return item.worktree != null;
  }
}
