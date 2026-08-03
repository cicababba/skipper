import {
  toReviewRound,
  type AgentReview,
  type CriticObjection,
  type ReviewRound,
} from "@skipper/shared";
import { bullet, joinBlocks } from "./md";

// Review serializer for the markdown export (#216). Minimal over today's review
// fields (#205 extends the shape later): metadata, then one section per round
// (history oldest-first, current last) with its objections and resolved items.

function statusSuffix(status: CriticObjection["status"]): string {
  if (status === "new") return " _(new)_";
  if (status === "persisting") return " _(persisting)_";
  return "";
}

function objectionLine(o: CriticObjection): string {
  const unverified = o.unverified ? " _(unverified)_" : "";
  return `- ${o.blocking ? "**Blocking** " : ""}${o.kind}: ${o.detail}${statusSuffix(o.status)}${unverified}`;
}

function objectionSection(heading: string, objections: CriticObjection[] | undefined): string | null {
  if (!objections || objections.length === 0) return null;
  return `${heading}\n\n${objections.map(objectionLine).join("\n")}`;
}

function roundBlock(r: ReviewRound): string {
  return joinBlocks([
    `## Round ${r.round} — ${r.outcome} (${r.at})`,
    r.reason || null,
    objectionSection("### Objections", r.objections),
    objectionSection("### Resolved", r.resolvedObjections),
  ]);
}

export function reviewMarkdown(review: AgentReview): string {
  const metadata = joinBlocks(
    [
      bullet("Outcome", review.outcome),
      bullet("Rounds", String(review.rounds)),
      bullet("Reviewed at", review.at),
      review.reason ? bullet("Reason", review.reason) : null,
    ],
    "\n",
  );
  const rounds: ReviewRound[] = [...(review.history ?? []), toReviewRound(review)];
  return joinBlocks(["# Review", metadata, ...rounds.map(roundBlock)]);
}
