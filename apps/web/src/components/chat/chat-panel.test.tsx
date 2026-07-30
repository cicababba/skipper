import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CodingEventEnvelope, PlanChatMessage } from "@skipper/shared";
import {
  ChatPanel,
  type ChatAdapter,
  type ChatAttachmentsAdapter,
  type ChatSendResult,
} from "./chat-panel";

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
  attachments?: ChatAttachmentsAdapter;
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
      attachments={opts.attachments}
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
    expect(adapter.send).toHaveBeenCalledWith("hello", undefined);
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
    expect(send).toHaveBeenNthCalledWith(2, "hello", undefined);
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

// Attachments (#281). jsdom has no DataTransfer and no ObjectURL, so the paste
// and drop inits are hand-built and the URL statics are stubbed. Events go on the
// textarea: React's delegation carries the drop up to the composer wrapper.
const ATTACH_WARNING =
  "The selected agent runtime may not be able to read this file type — it could be ignored.";

function file(name: string, bytes = "x") {
  return new File([bytes], name, { type: "application/octet-stream" });
}

function attachmentsAdapter(
  over: Partial<ChatAttachmentsAdapter> = {},
): ChatAttachmentsAdapter & { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> } {
  return {
    attach: vi.fn(async (f: File) => ({
      ok: true as const,
      path: `/data/attachments/chat-1/${f.name}`,
      name: f.name,
      supported: true,
    })),
    detach: vi.fn(),
    ...over,
  } as ChatAttachmentsAdapter & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
}

const paste = (files: File[]) =>
  fireEvent.paste(screen.getByPlaceholderText("Ask…"), { clipboardData: { files } });

const drop = (files: File[]) =>
  fireEvent.drop(screen.getByPlaceholderText("Ask…"), {
    dataTransfer: { files, types: ["Files"] },
  });

/** The input chip owns the remove button; the transcript chip does not. */
const removeButtons = () => screen.queryAllByRole("button", { name: "Remove attachment" });

beforeEach(() => {
  const url = URL as unknown as Record<string, unknown>;
  url.createObjectURL = vi.fn(() => "blob:preview-1");
  url.revokeObjectURL = vi.fn();
});

describe("ChatPanel — attachments (#281)", () => {
  it("attaches a pasted image and shows its chip with a preview", async () => {
    const attachments = attachmentsAdapter();
    renderPanel({ attachments });

    paste([file("shot.png")]);

    expect(await screen.findByText("shot.png")).toBeTruthy();
    expect(attachments.attach).toHaveBeenCalledOnce();
    expect(removeButtons()).toHaveLength(1);
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "shot.png" }).getAttribute("src")).toBe("blob:preview-1");
  });

  it("attaches dropped files, and mints no preview for a non-image", async () => {
    const attachments = attachmentsAdapter();
    renderPanel({ attachments });

    drop([file("spec.pdf"), file("notes.md")]);

    expect(await screen.findByText("spec.pdf")).toBeTruthy();
    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(attachments.attach).toHaveBeenCalledTimes(2);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("does nothing without the adapter, so the plan and agent chats are untouched", async () => {
    renderPanel({});
    paste([file("shot.png")]);
    drop([file("spec.pdf")]);
    await waitFor(() => expect(screen.queryByText("shot.png")).toBeNull());
    expect(removeButtons()).toHaveLength(0);
  });

  it("detaches the file when the chip's X is clicked", async () => {
    const attachments = attachmentsAdapter();
    renderPanel({ attachments });
    paste([file("shot.png")]);
    await screen.findByText("shot.png");

    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(screen.queryByText("shot.png")).toBeNull());
    expect(attachments.detach).toHaveBeenCalledWith("/data/attachments/chat-1/shot.png");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  });

  it("sends the pending attachments with the text and clears the chip strip", async () => {
    const attachments = attachmentsAdapter();
    const { adapter } = renderPanel({ attachments });
    paste([file("shot.png")]);
    await screen.findByText("shot.png");

    type("why is the header cut off?");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(adapter.send).toHaveBeenCalledWith("why is the header cut off?", [
        { name: "shot.png", path: "/data/attachments/chat-1/shot.png" },
      ]),
    );
    // The chips move into the transcript bubble; the input strip is empty again.
    await waitFor(() => expect(removeButtons()).toHaveLength(0));
    expect(screen.getByText("shot.png")).toBeTruthy();
  });

  it("keeps requiring text — attachments alone do not enable Send", async () => {
    renderPanel({ attachments: attachmentsAdapter() });
    paste([file("shot.png")]);
    await screen.findByText("shot.png");

    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    type("now with a question");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("warns when the runtime cannot read the attached kind", async () => {
    const attachments = attachmentsAdapter({
      attach: vi.fn(async (f: File) => ({
        ok: true as const,
        path: `/data/attachments/chat-1/${f.name}`,
        name: f.name,
        supported: false,
      })),
    });
    renderPanel({ attachments });

    paste([file("shot.png")]);

    expect(await screen.findByText(ATTACH_WARNING)).toBeTruthy();

    // The warning belongs to the chips: removing the last one clears it.
    fireEvent.click(removeButtons()[0]);
    await waitFor(() => expect(screen.queryByText(ATTACH_WARNING)).toBeNull());
  });

  it("rejects an unsupported type and an oversized file before calling attach", async () => {
    const attachments = attachmentsAdapter();
    renderPanel({ attachments });

    drop([file("payload.docx")]);
    expect(await screen.findByText(/Unsupported file type/)).toBeTruthy();

    const huge = file("huge.png");
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
    drop([huge]);
    expect(await screen.findByText(/File is too large/)).toBeTruthy();

    expect(attachments.attach).not.toHaveBeenCalled();
  });

  it("surfaces a failed attach without adding a chip", async () => {
    const attachments = attachmentsAdapter({
      attach: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });
    renderPanel({ attachments });

    paste([file("shot.png")]);

    expect(await screen.findByText(/Could not attach the file: disk full/)).toBeTruthy();
    expect(removeButtons()).toHaveLength(0);
  });

  it("stops at four attachments per message", async () => {
    const attachments = attachmentsAdapter();
    renderPanel({ attachments });

    drop(["a.png", "b.png", "c.png", "d.png", "e.png"].map((n) => file(n)));

    expect(await screen.findByText(/At most 4 files per message/)).toBeTruthy();
    await waitFor(() => expect(removeButtons()).toHaveLength(4));
    expect(attachments.attach).toHaveBeenCalledTimes(4);
  });

  it("resends the attachments when a failed turn is retried", async () => {
    const send = vi
      .fn<ChatAdapter["send"]>()
      .mockResolvedValueOnce({ ok: false, error: "boom" })
      .mockResolvedValueOnce({ ok: true, reply: "second time lucky" });
    renderPanel({ send, attachments: attachmentsAdapter() });
    paste([file("shot.png")]);
    await screen.findByText("shot.png");

    type("look at this");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/The chat turn failed: boom/);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("second time lucky")).toBeTruthy();
    expect(send).toHaveBeenNthCalledWith(2, "look at this", [
      { name: "shot.png", path: "/data/attachments/chat-1/shot.png" },
    ]);
  });

  it("hands the chips back with the text on Dismiss", async () => {
    renderPanel({
      send: vi.fn().mockResolvedValue({ ok: false }),
      attachments: attachmentsAdapter(),
    });
    paste([file("shot.png")]);
    await screen.findByText("shot.png");

    type("look at this");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect((screen.getByPlaceholderText("Ask…") as HTMLTextAreaElement).value).toBe(
        "look at this",
      ),
    );
    expect(removeButtons()).toHaveLength(1);
  });

  it("restores the chips when the turn is cancelled", async () => {
    const pending = deferred<ChatSendResult>();
    const cancel = vi.fn(() => pending.resolve({ ok: false, cancelled: true }));
    renderPanel({
      send: vi.fn().mockReturnValue(pending.promise),
      cancel,
      attachments: attachmentsAdapter(),
    });
    paste([file("shot.png")]);
    await screen.findByText("shot.png");

    type("look at this");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByText("The chat turn was cancelled.")).toBeTruthy();
    await waitFor(() => expect(removeButtons()).toHaveLength(1));
  });
});

// The transcript keeps name chips after a resume, when the bytes are long gone.
describe("ChatPanel — attachment chips in the transcript (#281)", () => {
  it("renders the stored names on a restored user turn", async () => {
    renderPanel({
      history: [
        {
          role: "user",
          text: "why is the header cut off?",
          at: "2026-07-30T09:00:00.000Z",
          attachments: [
            { name: "shot.png", path: "/data/attachments/chat-1/shot.png" },
            { name: "spec.pdf", path: "/data/attachments/chat-1/spec.pdf" },
          ],
        },
      ],
    });

    expect(await screen.findByText("shot.png")).toBeTruthy();
    expect(screen.getByText("spec.pdf")).toBeTruthy();
    // Read-back is out of scope: names only, no image element and no remove.
    expect(screen.queryByRole("img")).toBeNull();
    expect(removeButtons()).toHaveLength(0);
  });
});
