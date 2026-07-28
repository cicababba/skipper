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
