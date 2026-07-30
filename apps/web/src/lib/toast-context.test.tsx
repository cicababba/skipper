import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ToastHost } from "@/components/toast-host";
import { ToastProvider, useToast, type ToastOptions } from "./toast-context";

let api: ReturnType<typeof useToast> | null = null;

function Capture() {
  const value = useToast();
  useEffect(() => {
    api = value;
  }, [value]);
  return null;
}

function renderToasts() {
  return render(
    <ToastProvider>
      <Capture />
      <ToastHost />
    </ToastProvider>,
  );
}

function issue(options: ToastOptions) {
  let id = "";
  act(() => {
    id = api!.toast(options);
  });
  return id;
}

function cardFor(title: string) {
  return screen.getByText(title).closest(".w-80") as HTMLElement;
}

function cardCount(container: HTMLElement) {
  return container.querySelectorAll(".w-80").length;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  api = null;
});

describe("toast system", () => {
  it("renders the title and message of an issued toast", () => {
    renderToasts();
    issue({ title: "Plan ready", message: "Confidence 0.82" });

    expect(screen.getByText("Plan ready")).toBeTruthy();
    expect(screen.getByText("Confidence 0.82")).toBeTruthy();
  });

  it("borders the card according to the variant", () => {
    renderToasts();
    issue({ title: "info one" });
    issue({ variant: "success", title: "success one" });
    issue({ variant: "error", title: "error one" });

    expect(cardFor("info one").className).toContain("border-accent/30");
    expect(cardFor("success one").className).toContain("border-success/30");
    expect(cardFor("error one").className).toContain("border-danger/30");
  });

  it("auto-dismisses an info toast after 5000 ms", () => {
    renderToasts();
    issue({ title: "saved" });

    act(() => void vi.advanceTimersByTime(4999));
    expect(screen.queryByText("saved")).toBeTruthy();

    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByText("saved")).toBeNull();
  });

  it("keeps an error toast until it is dismissed", () => {
    renderToasts();
    issue({ variant: "error", title: "run failed" });

    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.queryByText("run failed")).toBeTruthy();
  });

  it("keeps a toast with an action, and running the action removes it", () => {
    renderToasts();
    const onClick = vi.fn();
    issue({ title: "PR opened", action: { label: "Open PR", onClick } });

    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.queryByText("PR opened")).toBeTruthy();

    fireEvent.click(screen.getByText("Open PR"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("PR opened")).toBeNull();
  });

  it("removes the toast and fires onDismiss when dismiss is clicked", () => {
    const { container } = renderToasts();
    const onDismiss = vi.fn();
    issue({ variant: "error", title: "run failed", onDismiss });

    fireEvent.click(within(cardFor("run failed")).getByText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("run failed")).toBeNull();
    expect(cardCount(container)).toBe(0);
  });

  it("does not fire onDismiss when the toast auto-dismisses", () => {
    renderToasts();
    const onDismiss = vi.fn();
    issue({ title: "saved", onDismiss });

    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByText("saved")).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("shows at most three toasts and promotes a queued one with a full duration", () => {
    const { container } = renderToasts();
    for (const n of [1, 2, 3, 4, 5]) issue({ variant: "error", title: `toast ${n}` });

    expect(cardCount(container)).toBe(3);
    expect(screen.queryByText("toast 3")).toBeTruthy();
    expect(screen.queryByText("toast 4")).toBeNull();

    act(() => void vi.advanceTimersByTime(3000));
    fireEvent.click(within(cardFor("toast 1")).getByText("Dismiss"));

    expect(cardCount(container)).toBe(3);
    expect(screen.queryByText("toast 4")).toBeTruthy();
  });

  it("starts the auto-dismiss timer only once a queued toast becomes visible", () => {
    renderToasts();
    for (const n of [1, 2, 3]) issue({ variant: "error", title: `sticky ${n}` });
    issue({ title: "queued" });

    act(() => void vi.advanceTimersByTime(3000));
    fireEvent.click(within(cardFor("sticky 1")).getByText("Dismiss"));
    expect(screen.queryByText("queued")).toBeTruthy();

    act(() => void vi.advanceTimersByTime(4999));
    expect(screen.queryByText("queued")).toBeTruthy();

    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByText("queued")).toBeNull();
  });

  it("replaces a toast issued again with the same id instead of stacking", () => {
    const { container } = renderToasts();
    issue({ id: "job-1", variant: "error", title: "job running" });
    issue({ id: "job-1", variant: "error", title: "job finished" });

    expect(cardCount(container)).toBe(1);
    expect(screen.queryByText("job running")).toBeNull();
    expect(screen.getByText("job finished")).toBeTruthy();
  });
});
