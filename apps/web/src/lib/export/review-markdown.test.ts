import { describe, expect, it } from "vitest";
import type { AgentReview, CriticObjection, ReviewRound } from "@skipper/shared";
import { reviewMarkdown } from "./review-markdown";

const obj = (
  detail: string,
  over: Partial<CriticObjection> = {},
): CriticObjection => ({ kind: "risk", detail, blocking: false, ...over });

function review(over: Partial<AgentReview> = {}): AgentReview {
  return { rounds: 1, outcome: "approve", at: "2026-07-23T02:00:00.000Z", ...over };
}

describe("reviewMarkdown", () => {
  it("renders header, metadata and a single round for a bare review", () => {
    const md = reviewMarkdown(review());
    expect(md).toContain("# Review");
    expect(md).toContain("- **Outcome:** approve");
    expect(md).toContain("- **Rounds:** 1");
    expect(md).toContain("- **Reviewed at:** 2026-07-23T02:00:00.000Z");
    expect(md).toContain("## Round 1 — approve (2026-07-23T02:00:00.000Z)");
    expect(md).not.toContain("### Objections");
    expect(md).not.toContain("### Resolved");
    expect(md).not.toContain("**Reason:**");
  });

  it("renders the reason bullet when present", () => {
    expect(reviewMarkdown(review({ reason: "not converging" }))).toContain(
      "- **Reason:** not converging",
    );
  });

  it("formats objections with blocking prefix, kind and status suffix", () => {
    const md = reviewMarkdown(
      review({
        outcome: "reject",
        objections: [
          obj("d1", { blocking: true, status: "new" }),
          obj("d2", { kind: "other", status: "persisting" }),
          obj("d3"),
        ],
      }),
    );
    expect(md).toContain("### Objections");
    expect(md).toContain("- **Blocking** risk: d1 _(new)_");
    expect(md).toContain("- other: d2 _(persisting)_");
    // No blocking prefix, no status suffix when status absent.
    expect(md).toContain("- risk: d3");
    expect(md).not.toContain("- risk: d3 _(");
  });

  it("lists history rounds oldest-first with the current round last", () => {
    const history: ReviewRound[] = [{ round: 1, outcome: "reject", at: "t1" }];
    const md = reviewMarkdown(review({ rounds: 2, outcome: "approve", at: "t2", history }));
    const first = md.indexOf("## Round 1 — reject (t1)");
    const second = md.indexOf("## Round 2 — approve (t2)");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it("renders a resolved section from resolvedObjections", () => {
    const md = reviewMarkdown(review({ resolvedObjections: [obj("was fixed")] }));
    expect(md).toContain("### Resolved");
    expect(md).toContain("- risk: was fixed");
  });
});
