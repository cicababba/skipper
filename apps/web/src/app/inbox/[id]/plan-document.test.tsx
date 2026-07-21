import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { IssuePlan } from "@skipper/shared";
import { PlanDocument } from "./plan-document";

const docPlan: IssuePlan = {
  summary: "The summary.",
  files: [{ path: "src/a.ts", reason: "entry", status: "existing" }],
  steps: [{ title: "Do the thing", detail: "", files: [], symbols: [] }],
  acceptance: [{ criterion: "works", addressedBy: "step" }],
  risks: [], // empty on purpose — exercises the empty-section render rule
  openQuestions: [],
  estimatedSize: "m",
};

function renderDoc(overrides: Partial<React.ComponentProps<typeof PlanDocument>> = {}) {
  const props: React.ComponentProps<typeof PlanDocument> = {
    itemId: "item-1",
    plan: docPlan,
    gate: true,
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

describe("PlanDocument — section render rules", () => {
  it("always renders the Summary section with its content", () => {
    renderDoc({ gate: false });
    expect(screen.getByText("Summary")).toBeTruthy();
    expect(screen.getByText("The summary.")).toBeTruthy();
  });

  it("renders empty sections at the gate", () => {
    renderDoc({ gate: true });
    expect(screen.getByText("Risks")).toBeTruthy();
  });

  it("hides count-0 sections when read-only (not at the gate)", () => {
    renderDoc({ gate: false });
    expect(screen.queryByText("Risks")).toBeNull();
    // Populated sections still render read-only.
    expect(screen.getByText("Steps")).toBeTruthy();
  });
});

describe("PlanDocument — collapsible primaries", () => {
  it("keeps a primary section collapsed by default and expands it on chevron click", () => {
    const { container } = renderDoc({ gate: false });
    expect(screen.queryByText("Do the thing")).toBeNull();

    const chevron = container.querySelector("#plan-doc-steps button") as HTMLButtonElement;
    expect(chevron).toBeTruthy();
    fireEvent.click(chevron);

    expect(screen.getByText("Do the thing")).toBeTruthy();
  });

  it("auto-expands a collapsed section when it becomes the editing section", () => {
    // editingSection points at a section not in the open set → still expanded.
    renderDoc({ gate: true, editingSection: "steps" });
    expect(screen.getByText("Do the thing")).toBeTruthy();
  });
});
