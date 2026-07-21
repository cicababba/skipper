import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { IssuePlan, PlanRevision } from "@skipper/shared";
import { PlanDocument } from "./plan-document";

const current: IssuePlan = {
  summary: "The summary.",
  files: [{ path: "src/a.ts", reason: "entry", status: "existing" }],
  steps: [{ title: "Do the thing", detail: "", files: [], symbols: [] }],
  acceptance: [{ criterion: "works", addressedBy: "step" }],
  risks: [],
  openQuestions: [],
  estimatedSize: "m",
};

function revision(plan: IssuePlan): PlanRevision {
  return { plan, at: "2026-07-21T10:00:00.000Z", source: "inline-edit" };
}

function renderDoc(overrides: Partial<React.ComponentProps<typeof PlanDocument>> = {}) {
  const props: React.ComponentProps<typeof PlanDocument> = {
    itemId: "item-1",
    plan: current,
    gate: false,
    editingSection: null,
    draft: null,
    saving: false,
    onStartEdit: () => {},
    onDraftChange: () => {},
    onSave: () => {},
    onCancel: () => {},
    memoryRefs: undefined,
    memoriesTitle: "Memories used",
    ...overrides,
  };
  return render(<PlanDocument {...props} />);
}

afterEach(() => {
  localStorage.clear();
});

describe("PlanDocument — Changes section (#165)", () => {
  it("renders no Changes section without revisions", () => {
    renderDoc();
    expect(screen.queryByText("Changes")).toBeNull();
  });

  it("hides the section when the latest revision equals the current plan", () => {
    renderDoc({ revisions: [revision({ ...current })] });
    expect(screen.queryByText("Changes")).toBeNull();
  });

  it("shows the heading with a count badge for a non-empty diff", () => {
    renderDoc({ revisions: [revision({ ...current, risks: ["old risk"] })] });
    expect(screen.getByText("Changes")).toBeTruthy();
    const heading = screen.getByText("Changes").closest("div");
    expect(heading?.textContent).toContain("1");
  });

  it("reveals per-section rows and before/after detail on expand", () => {
    const { container } = renderDoc({
      revisions: [revision({ ...current, risks: ["old risk"] })],
    });
    // Section body is collapsed by default — the Risks row is not shown yet.
    expect(screen.queryByText("Risks")).toBeNull();

    const sectionToggle = container.querySelector("#plan-doc-changes button") as HTMLButtonElement;
    fireEvent.click(sectionToggle);
    const rowLabel = screen.getByText("Risks");
    expect(rowLabel).toBeTruthy();

    // Row detail is collapsed until its own toggle is clicked.
    expect(screen.queryByText(/old risk/)).toBeNull();
    fireEvent.click(rowLabel.closest("button") as HTMLButtonElement);
    expect(screen.getByText(/old risk/)).toBeTruthy();
  });
});
