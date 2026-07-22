import { describe, it, expect, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { CodingEvent } from "@skipper/shared";
import { makeEventStream, EVENT_BUFFER_MAX } from "./event-stream";

function fakeWindow(destroyed = false): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const win = {
    isDestroyed: () => destroyed,
    webContents: { send },
  } as unknown as BrowserWindow;
  return { win, send };
}

type StatusPhase = Extract<CodingEvent, { kind: "status" }>["phase"];
const statusEvent = (phase: StatusPhase): CodingEvent => ({ kind: "status", phase });

const textEvent = (text: string): CodingEvent => ({ kind: "text", text });

describe("makeEventStream", () => {
  it("assigns monotonic seq from 0 with correct itemId and ISO timestamp", () => {
    const { win } = fakeWindow();
    const stream = makeEventStream({ channel: "coding", resetPhase: "fetching", getWindow: () => win });
    stream.emit("item-1", textEvent("a"));
    stream.emit("item-1", textEvent("b"));
    stream.emit("item-1", textEvent("c"));
    const events = stream.getEvents("item-1");
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events.every((e) => e.itemId === "item-1")).toBe(true);
    expect(events.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
    expect(events.map((e) => e.event)).toEqual([textEvent("a"), textEvent("b"), textEvent("c")]);
  });

  it("resets buffer and seq on a status event with the reset phase, firing onReset once", () => {
    const onReset = vi.fn();
    const { win } = fakeWindow();
    const stream = makeEventStream({
      channel: "coding",
      resetPhase: "fetching",
      getWindow: () => win,
      onReset,
    });
    stream.emit("item-1", textEvent("stale-1"));
    stream.emit("item-1", textEvent("stale-2"));
    stream.emit("item-1", statusEvent("fetching"));
    const events = stream.getEvents("item-1");
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(0);
    expect(events[0].event).toEqual(statusEvent("fetching"));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledWith("item-1");
  });

  it("does not reset on a status event with a different phase", () => {
    const onReset = vi.fn();
    const { win } = fakeWindow();
    const stream = makeEventStream({
      channel: "coding",
      resetPhase: "fetching",
      getWindow: () => win,
      onReset,
    });
    stream.emit("item-1", textEvent("keep"));
    stream.emit("item-1", statusEvent("worktree"));
    expect(stream.getEvents("item-1")).toHaveLength(2);
    expect(onReset).not.toHaveBeenCalled();
  });

  it("does not reset on a non-status event even with a matching detail", () => {
    const onReset = vi.fn();
    const { win } = fakeWindow();
    const stream = makeEventStream({
      channel: "review",
      resetPhase: "fetching",
      getWindow: () => win,
      onReset,
    });
    stream.emit("item-1", textEvent("keep"));
    stream.emit("item-1", { kind: "tool-use", tool: "fetching" });
    expect(stream.getEvents("item-1")).toHaveLength(2);
    expect(onReset).not.toHaveBeenCalled();
  });

  it("resets on the agent-start phase for the planning config", () => {
    const onReset = vi.fn();
    const { win } = fakeWindow();
    const stream = makeEventStream({
      channel: "planning",
      resetPhase: "agent-start",
      getWindow: () => win,
      onReset,
    });
    stream.emit("item-1", textEvent("stale"));
    stream.emit("item-1", statusEvent("agent-start"));
    expect(stream.getEvents("item-1")).toHaveLength(1);
    expect(stream.getEvents("item-1")[0].seq).toBe(0);
    expect(onReset).toHaveBeenCalledTimes(1);
    // A "fetching" status must NOT reset the planning stream.
    stream.emit("item-1", statusEvent("fetching"));
    expect(stream.getEvents("item-1")).toHaveLength(2);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("trims the buffer to EVENT_BUFFER_MAX, dropping the oldest", () => {
    const { win } = fakeWindow();
    const stream = makeEventStream({ channel: "coding", resetPhase: "fetching", getWindow: () => win });
    for (let i = 0; i < EVENT_BUFFER_MAX + 1; i++) stream.emit("item-1", textEvent(`e${i}`));
    const events = stream.getEvents("item-1");
    expect(events).toHaveLength(EVENT_BUFFER_MAX);
    expect(events[0].seq).toBe(1);
    expect(events.at(-1)?.seq).toBe(EVENT_BUFFER_MAX);
  });

  it("returns [] for an unknown itemId and keeps buffers/seq independent per item", () => {
    const { win } = fakeWindow();
    const stream = makeEventStream({ channel: "coding", resetPhase: "fetching", getWindow: () => win });
    expect(stream.getEvents("nope")).toEqual([]);
    stream.emit("a", textEvent("a1"));
    stream.emit("b", textEvent("b1"));
    stream.emit("b", textEvent("b2"));
    expect(stream.getEvents("a").map((e) => e.seq)).toEqual([0]);
    expect(stream.getEvents("b").map((e) => e.seq)).toEqual([0, 1]);
  });

  it("sends the envelope on the per-item channel with the exact name", () => {
    const { win, send } = fakeWindow();
    const stream = makeEventStream({ channel: "planning", resetPhase: "agent-start", getWindow: () => win });
    stream.emit("item-9", textEvent("hi"));
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, payload] = send.mock.calls[0];
    expect(channel).toBe("skipper:planning:event:item-9");
    expect(payload).toEqual(stream.getEvents("item-9")[0]);
  });

  it("does not send when the window is null but still records to the buffer", () => {
    const stream = makeEventStream({ channel: "coding", resetPhase: "fetching", getWindow: () => null });
    stream.emit("item-1", textEvent("a"));
    expect(stream.getEvents("item-1")).toHaveLength(1);
  });

  it("does not send when the window is destroyed but still records to the buffer", () => {
    const { win, send } = fakeWindow(true);
    const stream = makeEventStream({ channel: "coding", resetPhase: "fetching", getWindow: () => win });
    stream.emit("item-1", textEvent("a"));
    expect(send).not.toHaveBeenCalled();
    expect(stream.getEvents("item-1")).toHaveLength(1);
  });

  it("fires onEvent for every event (reset events included) after it is in the buffer", () => {
    const { win } = fakeWindow();
    const seen: Array<{ itemId: string; event: CodingEvent; buffered: boolean }> = [];
    let stream = undefined as unknown as ReturnType<typeof makeEventStream>;
    stream = makeEventStream({
      channel: "coding",
      resetPhase: "fetching",
      getWindow: () => win,
      onEvent: (itemId, event) => {
        seen.push({ itemId, event, buffered: stream.getEvents(itemId).at(-1)?.event === event });
      },
    });
    stream.emit("item-1", textEvent("a"));
    stream.emit("item-1", statusEvent("fetching"));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ itemId: "item-1", event: textEvent("a"), buffered: true });
    expect(seen[1]).toMatchObject({ itemId: "item-1", event: statusEvent("fetching"), buffered: true });
  });
});
