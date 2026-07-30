import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { UpdateState } from "@skipper/shared";
import { ToastProvider } from "@/lib/toast-context";
import { ToastHost } from "./toast-host";
import { UpdateToast } from "./update-toast";

const IDLE: UpdateState = { status: "idle", current: "1.0.0" };
const READY: UpdateState = { status: "ready", current: "1.0.0", available: "1.2.3" };

function installSkipper() {
  let emit: (state: UpdateState) => void = () => {};
  const getState = vi.fn().mockResolvedValue(IDLE);
  const restart = vi.fn().mockResolvedValue(undefined);
  const onStateChanged = vi.fn((callback: (state: UpdateState) => void) => {
    emit = callback;
    return () => {};
  });
  (window as unknown as { skipper: unknown }).skipper = {
    updates: { getState, onStateChanged, restart },
  };
  return { restart, emit: (state: UpdateState) => act(() => emit(state)) };
}

async function renderUpdateToast() {
  await act(async () => {
    render(
      <ToastProvider>
        <UpdateToast />
        <ToastHost />
      </ToastProvider>,
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("UpdateToast", () => {
  it("shows nothing while no update is ready", async () => {
    installSkipper();
    await renderUpdateToast();

    expect(screen.queryByText("Update ready")).toBeNull();
  });

  it("raises a toast once an update is downloaded", async () => {
    const { emit } = installSkipper();
    await renderUpdateToast();

    emit(READY);

    expect(screen.getByText("Update ready")).toBeTruthy();
    expect(screen.getByText(/Skipper 1\.2\.3 has been downloaded/)).toBeTruthy();
  });

  it("restarts the app from the action button", async () => {
    const { emit, restart } = installSkipper();
    await renderUpdateToast();

    emit(READY);
    fireEvent.click(screen.getByText("Restart now"));

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("keeps a dismissed version hidden when the same state is re-emitted", async () => {
    const { emit } = installSkipper();
    await renderUpdateToast();

    emit(READY);
    fireEvent.click(screen.getByText("Later"));
    expect(screen.queryByText("Update ready")).toBeNull();

    emit(READY);
    expect(screen.queryByText("Update ready")).toBeNull();
  });

  it("resurfaces for a newer version after a dismissal", async () => {
    const { emit } = installSkipper();
    await renderUpdateToast();

    emit(READY);
    fireEvent.click(screen.getByText("Later"));

    emit({ status: "ready", current: "1.0.0", available: "1.3.0" });

    expect(screen.getByText("Update ready")).toBeTruthy();
    expect(screen.getByText(/Skipper 1\.3\.0 has been downloaded/)).toBeTruthy();
  });
});
