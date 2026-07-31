import type { Issue, SourceRef } from "@skipper/shared";
import { dedupeRefs, parseBodyDependencies } from "../dependencies";

/**
 * Prerequisite work items ("blocked by") for one Bitbucket issue (#299). Body text
 * only, and deliberately so: Bitbucket Cloud has no native issue-link API. No HTTP.
 */
export function fetchBitbucketDependencies(issue: Issue): Promise<SourceRef[]> {
  const refs = parseBodyDependencies(issue.body, issue.sourceRef.project, "hash");
  return Promise.resolve(dedupeRefs(refs, issue.sourceRef));
}
