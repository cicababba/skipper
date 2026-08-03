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

/**
 * Branch / worktree-dir / label leaf. Numeric keys keep the historical prefix
 * ("42" → "issue-42"); tracker keys already carry their own project id, so
 * prefixing would duplicate it ("PROJ-12" → "proj-12", "ISSUE-1" → "issue-1").
 */
export function issueSlug(key: string): string {
  const slug = slugKey(key);
  return /^\d+$/.test(slug) ? `issue-${slug}` : slug;
}

/** Agent branch name. GitHub "42" → "feature/issue-42" — byte-identical to the pre-#71 scheme. */
export function issueBranchFor(key: string): string {
  return `feature/${issueSlug(key)}`;
}

const BRANCH_LEAF_RE = /^(?:feature|fix)\/(.+)$/;

/**
 * True when a PR head branch names this item: feature|fix/<leaf>, exact or
 * followed by "-" (human branches append a description). The dash boundary keeps
 * "PROJ-12" from claiming "proj-123". The legacy "issue-<slug>" leaf is accepted
 * too, so branches cut before #306 keep linking.
 */
export function branchNamesKey(headRef: string, itemKey: string): boolean {
  const match = BRANCH_LEAF_RE.exec(headRef);
  if (!match) return false;
  const slug = slugKey(itemKey);
  if (!slug) return false;
  const leaf = match[1].toLowerCase();
  for (const form of new Set([issueSlug(itemKey), `issue-${slug}`])) {
    if (leaf === form || leaf.startsWith(`${form}-`)) return true;
  }
  return false;
}
