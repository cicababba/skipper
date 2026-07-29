import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComposerDraftIssue } from "@skipper/shared";
import type { CardCreateState } from "@/lib/composer/create-flow";
import { DraftIssueCard } from "./draft-issue-card";

const ISSUE: ComposerDraftIssue = {
  title: "web:feat: rate-limit the webhook",
  body: "Throttle inbound calls.",
  acceptanceCriteria: ["429 after the cap"],
  labels: ["web"],
};

function renderCard(
  over: {
    issue?: ComposerDraftIssue;
    createState?: CardCreateState;
    locked?: boolean;
    relations?: string[];
  } = {},
) {
  const onEdit = vi.fn();
  const onBlur = vi.fn();
  const onRetry = vi.fn();
  render(
    <DraftIssueCard
      index={0}
      issue={over.issue ?? ISSUE}
      relations={over.relations ?? []}
      labelSuggestions={["core", "web"]}
      createState={over.createState ?? { status: "pending" }}
      locked={over.locked ?? false}
      busy={false}
      onEdit={onEdit}
      onBlur={onBlur}
      onRetry={onRetry}
    />,
  );
  return { onEdit, onBlur, onRetry };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("DraftIssueCard", () => {
  it("reports a title edit with its field so the flag can be recorded", () => {
    const { onEdit, onBlur } = renderCard();
    const input = screen.getByLabelText("Title");
    fireEvent.change(input, { target: { value: "my own title" } });
    expect(onEdit).toHaveBeenCalledWith(0, { field: "title", value: "my own title" });
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalled();
  });

  it("reports body and acceptance-criteria edits", () => {
    const { onEdit } = renderCard();
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "new body" } });
    expect(onEdit).toHaveBeenCalledWith(0, { field: "body", value: "new body" });

    fireEvent.change(screen.getByLabelText("Acceptance criteria 1"), {
      target: { value: "429 always" },
    });
    expect(onEdit).toHaveBeenCalledWith(0, {
      field: "acceptanceCriteria",
      value: ["429 always"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    expect(onEdit).toHaveBeenCalledWith(0, {
      field: "acceptanceCriteria",
      value: ["429 after the cap", ""],
    });
  });

  it("removes a label chip", () => {
    const { onEdit } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Remove web" }));
    expect(onEdit).toHaveBeenCalledWith(0, { field: "labels", value: [] });
  });

  it("swaps the body editor for a rendered preview and back", () => {
    renderCard();
    expect(screen.getByLabelText("Body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.queryByLabelText("Body")).toBeNull();
    expect(screen.getByText("Throttle inbound calls.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Body")).toBeTruthy();
  });

  it("locks the fields once the issue exists on the tracker", () => {
    renderCard({ locked: true, createState: { status: "created", url: "https://x/1", number: 7 } });
    expect((screen.getByLabelText("Title") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /#7 created/ })).toBeTruthy();
  });

  it("offers a retry on a failed card", () => {
    const { onRetry } = renderCard({ createState: { status: "failed", error: "403" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows the relation lines read-only", () => {
    renderCard({ relations: ["2 blocks 1"] });
    expect(screen.getByText("2 blocks 1")).toBeTruthy();
  });
});
