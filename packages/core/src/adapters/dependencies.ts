import { sourceRefKey, type SourceRef } from "@skipper/shared";

/** How a tracker spells an issue reference in body text. "hash" is the
 *  GitHub/GitLab/OpenProject/Bitbucket form ("#42", "owner/repo#42"), "jira" the
 *  project-prefixed key form ("PROJ-123"). */
export type DependencyRefStyle = "hash" | "jira";

// "blocked by" / "depends on", followed by a comma- or "and"-separated ref list.
// Bare-whitespace continuation is deliberately excluded so prose after a ref
// ("blocked by #3 see #4") is not swallowed.
const DEP_PHRASE_RE =
  /\b(?:blocked +by|depends +on)\b[:\s]+((?:[\w.-]+\/[\w.-]+)?#\d+(?:(?:\s*,\s*|\s+and\s+)(?:[\w.-]+\/[\w.-]+)?#\d+)*)/gi;
const DEP_REF_RE = /([\w.-]+\/[\w.-]+)?#(\d+)/g;

// Same phrase grammar over Jira keys. The phrase match is case-insensitive but
// the ref extraction is not: Jira keys are uppercase, so "blocked by proj-1"
// yields no refs rather than an unresolvable one.
const DEP_JIRA_PHRASE_RE =
  /\b(?:blocked +by|depends +on)\b[:\s]+([A-Z][A-Z0-9_]*-\d+(?:(?:\s*,\s*|\s+and\s+)[A-Z][A-Z0-9_]*-\d+)*)/gi;
const DEP_JIRA_REF_RE = /\b([A-Z][A-Z0-9_]*)-(\d+)\b/g;

/** Same-tracker prerequisite refs parsed from issue body text (fallback for #85).
 *  "hash" refs are "#N" (→ the issue's own project) or "owner/repo#N"; "jira" refs
 *  are "PROJ-123", whose project is the key prefix. */
export function parseBodyDependencies(
  body: string | undefined,
  project: string,
  style: DependencyRefStyle,
): SourceRef[] {
  if (!body) return [];
  const refs: SourceRef[] = [];
  if (style === "jira") {
    for (const phrase of body.matchAll(DEP_JIRA_PHRASE_RE)) {
      for (const ref of phrase[1].matchAll(DEP_JIRA_REF_RE)) {
        refs.push({ project: ref[1], key: ref[0] });
      }
    }
    return refs;
  }
  for (const phrase of body.matchAll(DEP_PHRASE_RE)) {
    for (const ref of phrase[1].matchAll(DEP_REF_RE)) {
      refs.push({ project: ref[1] ?? project, key: ref[2] });
    }
  }
  return refs;
}

/** Drops self-references and duplicates, preserving first-seen order. */
export function dedupeRefs(refs: SourceRef[], self: SourceRef): SourceRef[] {
  const selfKey = sourceRefKey(self);
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const ref of refs) {
    const key = sourceRefKey(ref);
    if (key === selfKey || seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
