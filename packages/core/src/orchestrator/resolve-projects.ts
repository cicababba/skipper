import type { Issue, RepoRef, UnmappedProject } from "@skipper/shared";
import { projectMappingKey } from "@skipper/shared";

export interface ResolveProjectReposResult {
  /** Input issues with `repo` filled from the mapping where one applies; issues
   *  that already carry a repo pass through untouched. */
  issues: Issue[];
  /** Projects with open, still-repo-less issues, aggregated with a count. */
  unmapped: UnmappedProject[];
}

/** "owner/name" → RepoRef; undefined when either half is missing (malformed value). */
function parseRepoValue(value: string): RepoRef | undefined {
  const [owner, name] = value.split("/");
  if (!owner || !name) return undefined;
  return { owner, name };
}

/**
 * Fills the repo of tracker issues whose project has no inherent repo (#79) from
 * the settings project→repo mapping. Repo-carrying issues (GitHub/GitLab) pass
 * through untouched. Issues left repo-less — no mapping, or a malformed mapping
 * value — are counted per project (open only) so the UI can prompt for a mapping.
 * Pure: produces copies, never mutates the input issues.
 */
export function resolveProjectRepos(
  issues: Issue[],
  target: { accountId: string; host: string },
  projectMappings: Record<string, string>,
): ResolveProjectReposResult {
  const out: Issue[] = [];
  const unmappedByKey = new Map<string, UnmappedProject>();

  for (const issue of issues) {
    if (issue.repo) {
      out.push(issue);
      continue;
    }
    const key = projectMappingKey(issue.source, target.host, issue.sourceRef.project);
    const value = projectMappings[key];
    const repo = value ? parseRepoValue(value) : undefined;
    if (repo) {
      out.push({ ...issue, repo });
      continue;
    }
    // Still repo-less: passes through unchanged so reconcile can see it (never
    // admitted; a closed one still closes a tracked item). Count open issues so
    // the warning surface reflects real pending work, not stale/closed items.
    out.push(issue);
    if (issue.state === "open") {
      const existing = unmappedByKey.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        unmappedByKey.set(key, {
          source: issue.source,
          host: target.host,
          projectKey: issue.sourceRef.project.toUpperCase(),
          count: 1,
          accountId: target.accountId,
        });
      }
    }
  }

  return { issues: out, unmapped: [...unmappedByKey.values()] };
}
