import { describe, expect, it } from "vitest";
import type { LifecycleState, TrackedItem } from "@skipper/shared";
import { interlocutorFor } from "./item-detail";

function makeItem(state: LifecycleState, extra: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "1",
    source: "github",
    sourceRef: { project: "o/r", key: "1" },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "o", name: "r" },
    key: "1",
    number: 1,
    title: "t",
    url: "https://github.com/o/r/issues/1",
    state,
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
    transitions: [],
    ...extra,
  };
}

const worktree = { path: "/wt", branch: "feature/issue-1" };

describe("interlocutorFor", () => {
  it("routes the plan tab to the plan chat only when available", () => {
    const item = makeItem("plan-gate");
    expect(interlocutorFor("plan", item, true)).toBe("plan");
    expect(interlocutorFor("plan", item, false)).toBeNull();
  });

  it("never routes the overview tab", () => {
    expect(interlocutorFor("overview", makeItem("plan-gate"), true)).toBeNull();
  });

  it("routes the review tab to the reviewer once a review exists and the run is over", () => {
    const review = {
      rounds: 1,
      outcome: "approve" as const,
      reason: "r",
      at: "2026-07-21T10:00:00.000Z",
    };
    expect(interlocutorFor("review", makeItem("human-review", { review }), false)).toBe("reviewer");
    expect(interlocutorFor("review", makeItem("human-review"), false)).toBeNull();
    expect(interlocutorFor("review", makeItem("agent-review", { review }), false)).toBeNull();
  });

  it("gates the coder chat until the coder has run (#187): no sessionId, no chat", () => {
    const untouched = makeItem("plan-gate", { worktree });
    expect(interlocutorFor("worktree", untouched, false)).toBeNull();
  });

  it("routes the worktree tab to the coder once a coding session exists", () => {
    const coded = makeItem("human-review", { worktree: { ...worktree, sessionId: "s1" } });
    expect(interlocutorFor("worktree", coded, false)).toBe("coder");
  });

  it("keeps the coder chat off while the coder is running", () => {
    const coding = makeItem("coding", { worktree: { ...worktree, sessionId: "s1" } });
    expect(interlocutorFor("worktree", coding, false)).toBeNull();
  });
});
