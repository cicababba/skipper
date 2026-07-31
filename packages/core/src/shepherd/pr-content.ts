import {
  displayKey,
  repoKey,
  type CodeHostId,
  type IssuePlan,
  type IssueSourceId,
  type RepoRef,
  type SourceRef,
} from "@skipper/shared";
import type { CodeHost } from "../adapters/types";

export interface IssueLinkItem {
  source: IssueSourceId;
  codeHost: CodeHostId;
  sourceRef: SourceRef;
  repo: RepoRef;
  key: string;
  url: string;
}

/**
 * The tracker-link line for the PR body. A native "#N" reference is only correct
 * when the issue lives on this code host *and* in this very repo — anywhere else
 * it is dead text (foreign tracker) or points at an unrelated issue (same host,
 * other project). Same-host cross-project falls back to the URL form, which
 * GitHub and GitLab still honor as a closing reference.
 */
export function buildIssueLink(
  item: IssueLinkItem,
  host: Pick<CodeHost, "linkIssueText" | "linkIssueUrlText">,
): string {
  if (item.source !== item.codeHost) return `Tracker issue: ${item.url}`;
  if (item.sourceRef.project.toLowerCase() === repoKey(item.repo)) {
    return host.linkIssueText(item.key);
  }
  return host.linkIssueUrlText(item.url);
}

export function buildCommitMessage(item: { title: string; key: string }): string {
  return `${item.title} (${displayKey(item.key)})`;
}

export function buildPrTitle(item: { title: string }): string {
  return item.title;
}

export function buildPrBody(input: { issueLink: string; plan?: IssuePlan }): string {
  const { issueLink, plan } = input;
  const sections = [issueLink];
  if (plan) {
    sections.push(`## Plan\n\n${plan.summary}`);
    if (plan.acceptance.length > 0) {
      sections.push(
        `## Acceptance criteria\n\n${plan.acceptance.map((a) => `- ${a.criterion}`).join("\n")}`,
      );
    }
  }
  sections.push(`---\n\n🤖 Implemented by a coding agent via Skipper.`);
  return sections.join("\n\n");
}
