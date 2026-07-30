import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CodingEventEnvelope, PlanChatMessage } from "@skipper/shared";
import { ChatPanel, type ChatAdapter, type ChatSendResult } from "./chat-panel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderPanel(opts: {
  history?: PlanChatMessage[];
  send?: ChatAdapter["send"];
  cancel?: () => void;
  emit?: (cb: (e: CodingEventEnvelope) => void) => void;
}) {
  const adapter: ChatAdapter = {
    loadHistory: vi.fn().mockResolvedValue(opts.history ?? []),
    send: opts.send ?? vi.fn().mockResolvedValue({ ok: true, reply: "reply" }),
    cancel: opts.cancel,
  };
  const stream = {
    getEvents: vi.fn().mockResolvedValue([]),
    onEvent: vi.fn((_itemId: string, cb: (e: CodingEventEnvelope) => void) => {
      opts.emit?.(cb);
      return () => {};
    }),
  };
  render(
    <ChatPanel
      itemId="item-1"
      adapter={adapter}
      stream={stream}
      turnDetails={["plan chat"]}
      sendDetail="plan chat"
      placeholder="Ask…"
      onBusyChange={vi.fn()}
      emptyState={<p>Nothing yet</p>}
    />,
  );
  return { adapter, stream };
}

function type(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Ask…"), { target: { value: text } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatPanel — send", () => {
  it("shows the empty state until the first message", async () => {
    renderPanel({});
    expect(await screen.findByText("Nothing yet")).toBeTruthy();
  });

  it("keeps the optimistic bubble and appends the authoritative reply", async () => {
    const { adapter } = renderPanel({});
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("hello")).toBeTruthy();
    expect(await screen.findByText("reply")).toBeTruthy();
    expect(adapter.send).toHaveBeenCalledWith("hello");
  });
});

describe("ChatPanel — failure and retry (#260)", () => {
  it("keeps the failed bubble and offers Retry / Dismiss", async () => {
    const send = vi
      .fn<ChatAdapter["send"]>()
      .mockResolvedValueOnce({ ok: false, error: "boom" })
      .mockResolvedValueOnce({ ok: true, reply: "second time lucky" });
    renderPanel({ send });

    type("hello");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/The chat turn failed: boom/)).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("second time lucky")).toBeTruthy();
    expect(send).toHaveBeenNthCalledWith(2, "hello");
  });

  it("hands the text back to the composer on Dismiss", async () => {
    renderPanel({ send: vi.fn().mockResolvedValue({ ok: false }) });
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText("Ask…") as HTMLTextAreaElement).value).toBe("hello"),
    );
    expect(screen.queryByText("hello", { selector: "div" })).toBeNull();
  });
});

describe("ChatPanel — stop (#260)", () => {
  it("swaps Send for Stop while a turn is in flight and rolls back on cancel", async () => {
    const pending = deferred<ChatSendResult>();
    const cancel = vi.fn(() => pending.resolve({ ok: false, cancelled: true }));
    renderPanel({ send: vi.fn().mockReturnValue(pending.promise), cancel });

    type("hello");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const stop = await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(stop);

    expect(cancel).toHaveBeenCalled();
    expect(await screen.findByText("The chat turn was cancelled.")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByPlaceholderText("Ask…") as HTMLTextAreaElement).value).toBe("hello"),
    );
    expect(screen.queryByText("hello", { selector: "div" })).toBeNull();
  });
});

describe("ChatPanel — activity turns (#260)", () => {
  it("renders the streamed turn as an activity block in the transcript", async () => {
    renderPanel({
      emit: (cb) => {
        cb({
          itemId: "item-1",
          seq: 1,
          at: "2026-07-21T09:00:00.000Z",
          event: { kind: "status", phase: "resuming", detail: "plan chat" },
        });
        cb({
          itemId: "item-1",
          seq: 2,
          at: "2026-07-21T09:00:01.000Z",
          event: { kind: "tool-use", tool: "Read" },
        });
      },
    });

    expect(await screen.findByText("Agent activity · 1 step")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
  });
});

// jsdom reports zero geometry and stubs ResizeObserver as a no-op, so drive the
// sticky-to-bottom logic through settable scrollTop and constant scroll/client
// heights on the prototype, restored after each test to avoid leaking (#275).
function stubGeometry({ scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  const tops = new WeakMap<HTMLElement, number>();
  const keys = ["scrollHeight", "clientHeight", "scrollTop"] as const;
  const originals = keys.map((k) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, k));
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return scrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return clientHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return tops.get(this) ?? 0;
    },
    set(value: number) {
      tops.set(this, value);
    },
  });
  return () => {
    keys.forEach((k, i) => {
      const original = originals[i];
      if (original) Object.defineProperty(HTMLElement.prototype, k, original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    });
  };
}

function activityEmit(cb: (e: CodingEventEnvelope) => void) {
  cb({
    itemId: "item-1",
    seq: 1,
    at: "2026-07-21T09:00:00.000Z",
    event: { kind: "status", phase: "resuming", detail: "plan chat" },
  });
  cb({ itemId: "item-1", seq: 2, at: "2026-07-21T09:00:01.000Z", event: { kind: "tool-use", tool: "Read" } });
  cb({ itemId: "item-1", seq: 3, at: "2026-07-21T09:00:02.000Z", event: { kind: "tool-use", tool: "Grep" } });
}

describe("ChatPanel — activity autoscroll (#275)", () => {
  it("keeps the transcript pinned to the bottom as activity streams in", async () => {
    const restore = stubGeometry({ scrollHeight: 1000, clientHeight: 200 });
    try {
      renderPanel({ emit: activityEmit });
      await screen.findByText("Grep");
      const container = document.querySelector<HTMLElement>(".h-full.overflow-y-auto");
      expect(container).not.toBeNull();
      await waitFor(() => expect(container!.scrollTop).toBe(1000));
    } finally {
      restore();
    }
  });

  it("unsticks on scroll-up showing the pill, and re-sticks when it is clicked", async () => {
    const restore = stubGeometry({ scrollHeight: 1000, clientHeight: 200 });
    try {
      renderPanel({ emit: activityEmit });
      await screen.findByText("Grep");
      const container = document.querySelector<HTMLElement>(".h-full.overflow-y-auto")!;

      container.scrollTop = 50;
      fireEvent.scroll(container);

      const pill = await screen.findByRole("button", { name: "Jump to latest" });
      expect(container.scrollTop).toBe(50);

      fireEvent.click(pill);
      await waitFor(() => expect(container.scrollTop).toBe(1000));
      expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    } finally {
      restore();
    }
  });
});
