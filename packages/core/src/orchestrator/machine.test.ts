import { describe, it, expect } from "vitest";
import { canTransition, type TrackedItem } from "@skipper/shared";
import { applyTransition, IllegalTransitionError } from "./machine";

const NOW = new Date("2026-07-21T10:00:00.000Z");

function makeItem(state: TrackedItem["state"]): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "owner/repo", key: "1" },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "owner", name: "repo" },
    key: "1",
    number: 1,
    title: "issue 1",
    url: "https://github.com/owner/repo/issues/1",
    state,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    transitions: [],
  } as TrackedItem;
}

describe("machine — queued → planning (#156)", () => {
  it("allows the queued → planning replan edge", () => {
    expect(canTransition("queued", "planning")).toBe(true);
    const next = applyTransition(makeItem("queued"), "planning", "user", "base branch changed", {
      now: NOW,
    });
    expect(next.state).toBe("planning");
    expect(next.transitions.at(-1)).toMatchObject({ from: "queued", to: "planning", actor: "user" });
  });

  it("still rejects an illegal edge out of queued", () => {
    expect(canTransition("queued", "merged")).toBe(false);
    expect(() => applyTransition(makeItem("queued"), "merged", "user")).toThrow(
      IllegalTransitionError,
    );
  });
});
