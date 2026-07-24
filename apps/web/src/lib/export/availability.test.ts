import { describe, expect, it } from "vitest";
import type { AgentReview, TrackedItem } from "@skipper/shared";
import { exportAvailable } from "./availability";

function item(over: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "acme/widget", key: "42" },
    codeHost: "github",
    accountId: "acme",
    repo: { owner: "acme", name: "widget" },
    key: "42",
    title: "t",
    url: "u",
    state: "planning",
    createdAt: "2026-07-23T09:00:00.000Z",
    updatedAt: "2026-07-23T09:00:00.000Z",
    transitions: [],
    ...over,
  };
}

const review: AgentReview = { rounds: 1, outcome: "approve", at: "2026-07-23T12:00:00.000Z" };

describe("exportAvailable", () => {
  it("dossier is always available", () => {
    expect(exportAvailable("dossier", item())).toBe(true);
    expect(exportAvailable("dossier", item({ plan: { ref: "r" }, review }))).toBe(true);
  });

  it("plan needs a stored plan ref", () => {
    expect(exportAvailable("plan", item({ plan: { ref: "r" } }))).toBe(true);
    expect(exportAvailable("plan", item({ plan: { confidence: 0.5 } }))).toBe(false);
    expect(exportAvailable("plan", item())).toBe(false);
  });

  it("review needs an inline review", () => {
    expect(exportAvailable("review", item({ review }))).toBe(true);
    expect(exportAvailable("review", item())).toBe(false);
  });

  it("worktree needs a worktree", () => {
    expect(exportAvailable("worktree", item({ worktree: { path: "/w", branch: "b" } }))).toBe(true);
    expect(exportAvailable("worktree", item())).toBe(false);
  });
});
