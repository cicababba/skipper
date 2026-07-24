import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CleanWorktreeResult } from "@skipper/shared";
import { CleanWorktreeDialog } from "./clean-worktree-dialog";

function setup(props: Partial<React.ComponentProps<typeof CleanWorktreeDialog>> = {}) {
  const onConfirm =
    props.onConfirm ?? vi.fn(async (): Promise<CleanWorktreeResult> => ({ ok: true }));
  const onDismiss = props.onDismiss ?? vi.fn();
  render(
    <CleanWorktreeDialog
      branch={props.branch ?? "feature/issue-204"}
      dirtyFiles={props.dirtyFiles ?? ["src/a.ts", "src/b.ts"]}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
    />,
  );
  return { onConfirm, onDismiss };
}

const backdrop = () => document.querySelector(".fixed.inset-0") as HTMLElement;
const confirmButton = () =>
  screen.getByRole("button", { name: "Clean worktree" }) as HTMLButtonElement;
const cancelButton = () => screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CleanWorktreeDialog", () => {
  it("renders the branch-scoped body and every file path", () => {
    setup({ branch: "feature/issue-204", dirtyFiles: ["src/a.ts", "src/b.ts", "new.md"] });
    expect(screen.getByText(/feature\/issue-204/)).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
    expect(screen.getByText("new.md")).toBeTruthy();
  });

  it("calls onConfirm and disables the buttons while the call is in flight", async () => {
    let resolve!: (r: CleanWorktreeResult) => void;
    const onConfirm = vi.fn(() => new Promise<CleanWorktreeResult>((r) => (resolve = r)));
    setup({ onConfirm });
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(confirmButton().disabled).toBe(true));
    expect(cancelButton().disabled).toBe(true);
    resolve({ ok: true });
  });

  it("shows the error inline and re-enables the buttons on failure", async () => {
    const onConfirm = vi.fn(
      async (): Promise<CleanWorktreeResult> => ({ ok: false, error: "git reset --hard failed" }),
    );
    const { onDismiss } = setup({ onConfirm });
    fireEvent.click(confirmButton());
    expect(await screen.findByText("git reset --hard failed")).toBeTruthy();
    expect(confirmButton().disabled).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses on Escape and backdrop click while idle", () => {
    const { onDismiss } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(backdrop());
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("blocks Escape and backdrop dismiss while a call is in flight", async () => {
    let resolve!: (r: CleanWorktreeResult) => void;
    const onConfirm = vi.fn(() => new Promise<CleanWorktreeResult>((r) => (resolve = r)));
    const { onDismiss } = setup({ onConfirm });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmButton().disabled).toBe(true));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(backdrop());
    expect(onDismiss).not.toHaveBeenCalled();
    resolve({ ok: true });
  });

  it("calls onDismiss from the Cancel button", () => {
    const { onDismiss } = setup();
    fireEvent.click(cancelButton());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
