import { describe, expect, it } from "vitest";
import type { CodingEvent, CodingEventEnvelope } from "@skipper/shared";
import type { ChatTurn } from "./chat-turns";
import { draftFromTurn } from "./chat-draft";

function turnOf(events: CodingEvent[]): ChatTurn {
  const envelopes: CodingEventEnvelope[] = events.map((event, i) => ({
    itemId: "item-1",
    seq: i + 1,
    at: "2026-07-21T09:00:00.000Z",
    event,
  }));
  return { id: "t1", detail: "plan chat", openedAt: "2026-07-21T09:00:00.000Z", envelopes, open: true };
}

describe("draftFromTurn", () => {
  it("returns an empty string when there is no turn", () => {
    expect(draftFromTurn(null)).toBe("");
  });

  it("joins the text blocks in order, ignoring other events", () => {
    const draft = draftFromTurn(
      turnOf([
        { kind: "agent-init", sessionId: "s" },
        { kind: "text", text: "first" },
        { kind: "tool-use", tool: "Read" },
        { kind: "text", text: "second" },
      ]),
    );
    expect(draft).toBe("first\n\nsecond");
  });

  it("skips blank text blocks", () => {
    expect(draftFromTurn(turnOf([{ kind: "text", text: "   " }, { kind: "text", text: "real" }]))).toBe(
      "real",
    );
  });

  it("concatenates consecutive text-delta events with no separator", () => {
    const draft = draftFromTurn(
      turnOf([
        { kind: "text-delta", text: "Hel" },
        { kind: "text-delta", text: "lo " },
        { kind: "text-delta", text: "world" },
      ]),
    );
    expect(draft).toBe("Hello world");
  });

  it("joins a delta run and a block text segment with a blank line", () => {
    const draft = draftFromTurn(
      turnOf([
        { kind: "text-delta", text: "streamed " },
        { kind: "text-delta", text: "reply" },
        { kind: "text", text: "block" },
      ]),
    );
    expect(draft).toBe("streamed reply\n\nblock");
  });

  it("ignores a blank delta run", () => {
    const draft = draftFromTurn(
      turnOf([
        { kind: "text-delta", text: "  " },
        { kind: "text", text: "real" },
      ]),
    );
    expect(draft).toBe("real");
  });
});
