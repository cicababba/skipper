import type { Issue, SourceRef } from "@skipper/shared";
import { dedupeRefs, parseBodyDependencies } from "../dependencies";

/**
 * Prerequisite work items ("blocked by") for one GitLab issue (#299). Body text
 * only, and deliberately so: GitLab's native issue links ("blocks") are a Premium
 * feature, so body parsing is the only source available on the free tier. No HTTP.
 */
export function fetchGitLabDependencies(issue: Issue): Promise<SourceRef[]> {
  const refs = parseBodyDependencies(issue.body, issue.sourceRef.project, "hash");
  return Promise.resolve(dedupeRefs(refs, issue.sourceRef));
}
