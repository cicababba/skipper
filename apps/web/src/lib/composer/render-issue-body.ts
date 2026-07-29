// The body actually posted to the tracker (#136). CreateIssueParams has no slot
// for acceptance criteria, so the draft's list is folded into the markdown body
// as a checklist — the shape a maintainer expects to find in the issue.

import type { ComposerDraftIssue } from "@skipper/shared";

export const ACCEPTANCE_HEADING = "## Acceptance criteria";

export function renderDraftBody(issue: ComposerDraftIssue): string {
  const body = issue.body.trim();
  const criteria = issue.acceptanceCriteria.map((c) => c.trim()).filter((c) => c !== "");
  if (criteria.length === 0) return body;
  const checklist = criteria.map((c) => `- [ ] ${c}`).join("\n");
  const section = `${ACCEPTANCE_HEADING}\n\n${checklist}`;
  return body ? `${body}\n\n${section}` : section;
}
