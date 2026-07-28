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
});
