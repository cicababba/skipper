import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { IssuePlan, PlanRevision } from "@skipper/shared";
import { PlanDocument } from "./plan-document";

// jsdom has no scrollIntoView; viewChanges calls it inside requestAnimationFrame.
Element.prototype.scrollIntoView = () => {};

const docPlan: IssuePlan = {
  summary: "The summary.",
  files: [{ path: "src/a.ts", reason: "entry", status: "existing" }],
  steps: [{ title: "Do the thing", detail: "", files: [], symbols: [] }],
  acceptance: [{ criterion: "works", addressedBy: "step" }],
  risks: [], // empty on purpose — exercises the empty-section render rule
  openQuestions: [],
  estimatedSize: "m",
};

// Superseded body: summary changed, "Do the thing" added, "Removed step" removed.
const beforePlan: IssuePlan = {
  summary: "Old summary.",
  files: [{ path: "src/a.ts", reason: "entry", status: "existing" }],
  steps: [{ title: "Removed step", detail: "", files: [], symbols: [] }],
  acceptance: [{ criterion: "works", addressedBy: "step" }],
  risks: [],
  openQuestions: [],
  estimatedSize: "m",
};

function revision(plan: IssuePlan, over: Partial<PlanRevision> = {}): PlanRevision {
  return { plan, at: "2026-07-21T10:00:00.000Z", source: "chat-apply", ...over };
}

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

describe("PlanDocument — applied-changes banner (#201)", () => {
  it("shows the banner with the change count for a chat-apply revision", () => {
    const { container } = renderDoc({ revisions: [revision(beforePlan)] });
    expect(screen.getByText("View changes")).toBeTruthy();
    expect(container.textContent).toContain("Plan updated from discussion — 3 changes");
  });

  it("hides the banner for an inline-edit revision", () => {
    renderDoc({ revisions: [revision(beforePlan, { source: "inline-edit" })] });
    expect(screen.queryByText("View changes")).toBeNull();
  });

  it("dismissing the banner hides it and persists the dismissal", () => {
    renderDoc({ revisions: [revision(beforePlan)] });
    fireEvent.click(screen.getByTitle("Cancel"));
    expect(screen.queryByText("View changes")).toBeNull();
    expect(localStorage.getItem("skipper-plan-banner-dismissed:item-1")).toBe(
      "2026-07-21T10:00:00.000Z",
    );
  });

  it("re-shows the banner when a newer revision supersedes the dismissed one", () => {
    localStorage.setItem("skipper-plan-banner-dismissed:item-1", "2026-07-21T10:00:00.000Z");
    renderDoc({ revisions: [revision(beforePlan, { at: "2026-07-22T10:00:00.000Z" })] });
    expect(screen.getByText("View changes")).toBeTruthy();
  });

  it("expands the Changes section when View changes is clicked", () => {
    renderDoc({ revisions: [revision(beforePlan)] });
    expect(screen.queryByText(/chat apply/)).toBeNull();
    fireEvent.click(screen.getByText("View changes"));
    expect(screen.getByText(/chat apply/)).toBeTruthy();
  });
});

describe("PlanDocument — section badges & highlights (#201)", () => {
  it("shows an updated · N badge on each changed section header", () => {
    renderDoc({ revisions: [revision(beforePlan)] });
    expect(screen.getByText("updated · 1")).toBeTruthy(); // summary
    expect(screen.getByText("updated · 2")).toBeTruthy(); // steps (1 added + 1 removed)
  });

  it("marks a changed item with the accent border in normal mode", () => {
    const { container } = renderDoc({ revisions: [revision(beforePlan)] });
    const stepsToggle = container.querySelector("#plan-doc-steps button") as HTMLButtonElement;
    fireEvent.click(stepsToggle);
    const added = screen.getByText("Do the thing").closest("li");
    expect(added?.className).toContain("border-accent/40");
  });
});

describe("PlanDocument — inline diff mode (#201)", () => {
  it("renders struck-through removals and hides Edit affordances when toggled on", () => {
    const { container } = renderDoc({ revisions: [revision(beforePlan)] });
    const stepsToggle = container.querySelector("#plan-doc-steps button") as HTMLButtonElement;
    fireEvent.click(stepsToggle);

    // Edit affordances are present before entering diff mode.
    expect(screen.queryAllByTitle("Edit").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("Show changes"));

    const removed = screen.getByText("Removed step");
    expect(removed.className).toContain("line-through");
    expect(screen.queryByTitle("Edit")).toBeNull();
  });
});
