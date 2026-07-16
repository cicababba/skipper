import type { IssuePlan } from "@skipper/shared";

export function buildCommitMessage(item: { title: string; number: number }): string {
  return `${item.title} (#${item.number})`;
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
