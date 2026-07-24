import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CloseItemOnTrackerResult, TrackedItem } from "@skipper/shared";
import { CloseItemDialog } from "./close-item-dialog";

function item(over: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "octo/repo", key: "1" },
    codeHost: "github",
    accountId: "acc",
    repo: { owner: "octo", name: "repo" },
    key: "1",
    number: 1,
    title: "t",
    url: "https://github.com/octo/repo/issues/1",
    state: "triage",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    transitions: [],
    ...over,
  };
}

function setup(props: Partial<React.ComponentProps<typeof CloseItemDialog>> = {}) {
  const onCloseOnTracker =
    props.onCloseOnTracker ??
    vi.fn(async (): Promise<CloseItemOnTrackerResult> => ({ ok: true }));
  const onUntrack = props.onUntrack ?? vi.fn(async () => true);
  const onOpenInTracker = props.onOpenInTracker ?? vi.fn();
  const onDismiss = props.onDismiss ?? vi.fn();
  render(
    <CloseItemDialog
      item={props.item ?? item()}
      canCloseOnTracker={props.canCloseOnTracker ?? true}
      onCloseOnTracker={onCloseOnTracker}
      onUntrack={onUntrack}
      onOpenInTracker={onOpenInTracker}
      onDismiss={onDismiss}
    />,
  );
  return { onCloseOnTracker, onUntrack, onOpenInTracker, onDismiss };
}

const backdrop = () => document.querySelector(".fixed.inset-0") as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CloseItemDialog", () => {
  it("closes on the tracker for a capable source", async () => {
    const { onCloseOnTracker } = setup({ canCloseOnTracker: true });
    fireEvent.click(screen.getByRole("button", { name: "Close on GitHub" }));
    await waitFor(() => expect(onCloseOnTracker).toHaveBeenCalledTimes(1));
  });

  it("hides tracker-close and offers a link-out when the source can't close (Jira)", () => {
    const { onOpenInTracker } = setup({
      item: item({ source: "jira" }),
      canCloseOnTracker: false,
    });
    expect(screen.queryByRole("button", { name: /Close on/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in Jira" }));
    expect(onOpenInTracker).toHaveBeenCalledTimes(1);
  });

  it("triggers untrack from Remove from Skipper", async () => {
    const { onUntrack } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove from Skipper" }));
    await waitFor(() => expect(onUntrack).toHaveBeenCalledTimes(1));
  });

  it("dismisses on Escape", () => {
    const { onDismiss } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses on a backdrop click", () => {
    const { onDismiss } = setup();
    fireEvent.click(backdrop());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the tracker error inline and keeps the dialog open on failure", async () => {
    const onCloseOnTracker = vi.fn(
      async (): Promise<CloseItemOnTrackerResult> => ({
        ok: false,
        error: "Resource not accessible by integration",
      }),
    );
    const { onDismiss } = setup({ onCloseOnTracker });
    fireEvent.click(screen.getByRole("button", { name: "Close on GitHub" }));
    expect(await screen.findByText("Resource not accessible by integration")).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("disables actions and blocks dismiss while a close is in flight", async () => {
    let resolve!: (r: CloseItemOnTrackerResult) => void;
    const onCloseOnTracker = vi.fn(
      () => new Promise<CloseItemOnTrackerResult>((r) => (resolve = r)),
    );
    const { onDismiss } = setup({ onCloseOnTracker });
    fireEvent.click(screen.getByRole("button", { name: "Close on GitHub" }));

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Remove from Skipper" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    // Escape and backdrop are inert while a call is in flight.
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(backdrop());
    expect(onDismiss).not.toHaveBeenCalled();

    resolve({ ok: true });
  });
});
