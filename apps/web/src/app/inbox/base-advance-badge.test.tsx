import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { BaseAdvanceNotice, TrackedItem } from "@skipper/shared";
import { BaseAdvanceBadge } from "./base-advance-badge";

function item(baseAdvance?: BaseAdvanceNotice): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    key: "1",
    title: "fix the topbar jump",
    state: "plan-gate",
    transitions: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    baseAdvance,
  } as unknown as TrackedItem;
}

const notice: BaseAdvanceNotice = {
  at: "2026-08-07T12:00:00.000Z",
  mergedKeys: ["9"],
  overlapFiles: [],
  reason: "overlap",
};

describe("BaseAdvanceBadge", () => {
  it("renders nothing without a notice", () => {
    const { container } = render(<BaseAdvanceBadge item={item()} />);
    expect(container.firstChild).toBeNull();
  });

  it("flags an item whose base moved", () => {
    render(<BaseAdvanceBadge item={item(notice)} />);
    const badge = screen.getByText("base moved");
    expect(badge.getAttribute("title")).toBe(
      "Another PR merged on this repo after this plan was written.",
    );
  });
});
