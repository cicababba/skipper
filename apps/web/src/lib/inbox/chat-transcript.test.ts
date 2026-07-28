import { describe, expect, it } from "vitest";
import type { PlanChatMessage } from "@skipper/shared";
import type { ChatTurn } from "./chat-turns";
import { buildTranscript } from "./chat-transcript";

const msg = (text: string, at: string, role: "user" | "assistant" = "user"): PlanChatMessage => ({
  role,
  text,
  at,
});

const turn = (id: string, openedAt: string): ChatTurn => ({
  id,
  detail: "plan chat",
  openedAt,
  envelopes: [],
  open: false,
});

describe("buildTranscript", () => {
  it("interleaves messages and turns by timestamp", () => {
    const items = buildTranscript(
      [msg("q", "2026-07-21T09:00:00.000Z"), msg("a", "2026-07-21T09:00:10.000Z", "assistant")],
      [turn("t1", "2026-07-21T09:00:05.000Z")],
    );
    expect(items.map((i) => i.kind)).toEqual(["message", "turn", "message"]);
  });

  it("puts a message before a turn opened at the same instant", () => {
    const items = buildTranscript(
      [msg("q", "2026-07-21T09:00:00.000Z")],
      [turn("t1", "2026-07-21T09:00:00.000Z")],
    );
    expect(items.map((i) => i.kind)).toEqual(["message", "turn"]);
  });

  it("marks the failed message and leaves the others untouched", () => {
    const items = buildTranscript(
      [msg("q", "2026-07-21T09:00:00.000Z"), msg("q2", "2026-07-21T09:00:01.000Z")],
      [],
      { failedIndex: 1 },
    );
    expect(items.map((i) => i.kind === "message" && i.failed)).toEqual([false, true]);
  });

  it("appends the streamed draft last", () => {
    const items = buildTranscript(
      [msg("q", "2026-07-21T09:00:00.000Z")],
      [turn("t1", "2026-07-21T09:00:05.000Z")],
      { draft: "partial" },
    );
    expect(items[items.length - 1]).toEqual({ kind: "draft", text: "partial" });
  });

  it("omits the draft when it is empty", () => {
    const items = buildTranscript([msg("q", "2026-07-21T09:00:00.000Z")], [], { draft: "" });
    expect(items.some((i) => i.kind === "draft")).toBe(false);
  });
});
