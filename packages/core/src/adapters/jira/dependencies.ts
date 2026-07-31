import type { Issue, SourceRef } from "@skipper/shared";
import { dedupeRefs, parseBodyDependencies } from "../dependencies";

/**
 * Prerequisite work items ("blocked by") for one Jira issue (#299). The poll
 * payload already carries the native issue links, so this needs no request at
 * all. Body text ("Blocked by PROJ-1") is a fallback for when there are none:
 * native links are removable in Jira's UI while stale body text isn't, so a
 * union would over-block — same rationale as the GitHub adapter.
 */
export function fetchJiraDependencies(issue: Issue): Promise<SourceRef[]> {
  const native = issue.blockedBy ?? [];
  const refs =
    native.length > 0 ? native : parseBodyDependencies(issue.body, issue.sourceRef.project, "jira");
  return Promise.resolve(dedupeRefs(refs, issue.sourceRef));
}
