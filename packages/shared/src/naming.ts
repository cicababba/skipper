// ============================================================
// Skipper — work-item key naming (branches, worktree dirs, display)
// ============================================================
// Branch naming (desktop worktrees) and branch matching (core reconcile)
// must agree, so both live here — the one home for the convention.

/** Filesystem/branch-safe form of a work-item key: "42" → "42", "PROJ-123" → "proj-123". */
export function slugKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Human display form: "#42" for bare numbers (GitHub), verbatim otherwise ("PROJ-123"). */
export function displayKey(key: string): string {
  return /^\d+$/.test(key) ? `#${key}` : key;
}

/** Agent branch name. GitHub "42" → "feature/issue-42" — byte-identical to the pre-#71 scheme. */
export function issueBranchFor(key: string): string {
  return `feature/issue-${slugKey(key)}`;
}

/** Extracts the slug tail of an issue branch: "feature/issue-71-two-axis" → "71-two-axis". */
export const BRANCH_ISSUE_RE = /^(?:feature|fix)\/issue-([A-Za-z0-9][A-Za-z0-9-]*)/;

/**
 * True when a branch slug names this item: exact match, or the item's slug
 * followed by "-" (human branches append a description: feature/issue-71-two-axis-workitem).
 * The dash boundary keeps "PROJ-12" from claiming "proj-123".
 */
export function branchSlugMatchesKey(branchSlug: string, itemKey: string): boolean {
  const slug = branchSlug.toLowerCase();
  const key = slugKey(itemKey);
  return slug === key || slug.startsWith(`${key}-`);
}
