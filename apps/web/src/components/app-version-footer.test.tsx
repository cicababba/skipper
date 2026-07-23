import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { UpdateState } from "@skipper/shared";
import { AppVersionFooter } from "./app-version-footer";

type WindowWithSkipper = { skipper?: unknown };
type Listener = (state: UpdateState) => void;

function stubBridge(
  getState: () => Promise<UpdateState>,
  onStateChanged: (cb: Listener) => () => void = () => () => {},
) {
  (window as unknown as WindowWithSkipper).skipper = { updates: { getState, onStateChanged } };
}

// The `.catch(() => {})` on getState() is only observable through the absence
// of an unhandled rejection, so watch for one instead of trusting the runner.
let unhandled: PromiseRejectionEvent[] = [];
const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e);

beforeEach(() => {
  unhandled = [];
  window.addEventListener("unhandledrejection", onUnhandled);
});

afterEach(() => {
  window.removeEventListener("unhandledrejection", onUnhandled);
  delete (window as unknown as WindowWithSkipper).skipper;
});

describe("AppVersionFooter", () => {
  it("renders the running version from the updates bridge", async () => {
    stubBridge(async () => ({ status: "dev", current: "0.1.0" }));
    render(<AppVersionFooter />);
    expect(await screen.findByText(/Skipper v0\.1\.0/)).toBeTruthy();
  });

  // While the updater runs, its idle line already prints the version
  // ("You're on <v> — up to date", updates-section.tsx:52) and both live on the
  // Settings page — the footer must stay silent to avoid showing it twice.
  it("renders nothing while the updater is running", async () => {
    stubBridge(async () => ({ status: "idle", current: "0.1.0" }));
    const { container } = render(<AppVersionFooter />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("renders nothing without an Electron bridge", () => {
    delete (window as unknown as WindowWithSkipper).skipper;
    const { container } = render(<AppVersionFooter />);
    expect(container.textContent).toBe("");
  });

  it("follows updater state changes and unsubscribes on unmount", async () => {
    let captured: Listener | undefined;
    const unsubscribe = vi.fn();
    stubBridge(
      async () => ({ status: "dev", current: "0.1.0" }),
      (cb) => {
        captured = cb;
        return unsubscribe;
      },
    );

    const { unmount } = render(<AppVersionFooter />);
    expect(await screen.findByText(/Skipper v0\.1\.0/)).toBeTruthy();

    act(() => captured!({ status: "dev", current: "0.2.0" }));
    expect(await screen.findByText(/Skipper v0\.2\.0/)).toBeTruthy();

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing getState and still renders a later state event", async () => {
    const rejected = Promise.reject(new Error("boom"));
    let captured: Listener | undefined;
    stubBridge(
      () => rejected,
      (cb) => {
        captured = cb;
        return () => {};
      },
    );

    const { container } = render(<AppVersionFooter />);
    await rejected.catch(() => {});
    await waitFor(() => expect(container.textContent).toBe(""));

    // Still wired up after the rejection: an event repaints the footer.
    act(() => captured!({ status: "dev", current: "0.1.0" }));
    expect(await screen.findByText(/Skipper v0\.1\.0/)).toBeTruthy();

    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toHaveLength(0);
  });
});
