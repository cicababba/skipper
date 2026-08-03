import { describe, expect, it } from "vitest";
import {
  CHAT_SALVAGE_DETAIL,
  CHAT_TURN_DETAILS,
  type CodingEvent,
  type CodingEventEnvelope,
} from "@skipper/shared";
import {
  EMPTY_CHAT_STREAM_STATE,
  allTurns,
  mergeReplayIntoState,
  reduceLive,
  segmentTurns,
} from "./chat-turns";

const DETAILS = [CHAT_TURN_DETAILS.planChat, CHAT_TURN_DETAILS.planApply];

function env(seq: number, event: CodingEvent, at = `2026-07-21T09:00:${String(seq).padStart(2, "0")}.000Z`): CodingEventEnvelope {
  return { itemId: "item-1", seq, at, event };
}

const opener = (seq: number, detail: string = CHAT_TURN_DETAILS.planChat) =>
  env(seq, { kind: "status", phase: "resuming", detail });

describe("segmentTurns", () => {
  it("opens a turn on a matching resuming detail and attaches the events that follow", () => {
    const turns = segmentTurns(
      [
        opener(1),
        env(2, { kind: "agent-init", sessionId: "s" }),
        env(3, { kind: "text", text: "hello" }),
      ],
      DETAILS,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].detail).toBe(CHAT_TURN_DETAILS.planChat);
    expect(turns[0].envelopes.map((e) => e.seq)).toEqual([2, 3]);
    expect(turns[0].open).toBe(true);
  });

  it("ignores events that arrive outside any turn", () => {
    const turns = segmentTurns(
      [env(1, { kind: "text", text: "run output" }), opener(2), env(3, { kind: "text", text: "in" })],
      DETAILS,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].envelopes.map((e) => e.seq)).toEqual([3]);
  });

  it("closes the turn on result / error and attaches that event", () => {
    const turns = segmentTurns(
      [opener(1), env(2, { kind: "result", ok: true, turns: 2 }), env(3, { kind: "text", text: "after" })],
      DETAILS,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].open).toBe(false);
    expect(turns[0].envelopes.map((e) => e.seq)).toEqual([2]);
  });

  it("closes the turn without attaching when a run phase takes the stream over", () => {
    const turns = segmentTurns(
      [
        opener(1),
        env(2, { kind: "text", text: "in turn" }),
        env(3, { kind: "status", phase: "agent-start" }),
        env(4, { kind: "text", text: "run output" }),
      ],
      DETAILS,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].open).toBe(false);
    expect(turns[0].envelopes.map((e) => e.seq)).toEqual([2]);
  });

  it("closes without opening on a non-chat resuming detail (budget salvage)", () => {
    const turns = segmentTurns(
      [
        opener(1),
        env(2, { kind: "text", text: "in turn" }),
        env(3, { kind: "status", phase: "resuming", detail: "budget hit — salvaging final report" }),
        env(4, { kind: "text", text: "salvage" }),
      ],
      DETAILS,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].open).toBe(false);
    expect(turns[0].envelopes.map((e) => e.seq)).toEqual([2]);
  });

  it("keeps the turn open across the chat salvage notice and its wrap-up (#301)", () => {
    const turns = segmentTurns(
      [
        opener(1),
        env(2, { kind: "text", text: "in turn" }),
        env(3, { kind: "status", phase: "resuming", detail: CHAT_SALVAGE_DETAIL }),
        env(4, { kind: "text", text: "salvaged answer" }),
      ],
      DETAILS,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].open).toBe(true);
    expect(turns[0].envelopes.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it("closes the previous turn when a new opener arrives", () => {
    const turns = segmentTurns(
      [opener(1), env(2, { kind: "text", text: "a" }), opener(3, CHAT_TURN_DETAILS.planApply)],
      DETAILS,
    );
    expect(turns.map((t) => [t.detail, t.open])).toEqual([
      [CHAT_TURN_DETAILS.planChat, false],
      [CHAT_TURN_DETAILS.planApply, true],
    ]);
  });
});

describe("reduceLive", () => {
  it("appends in seq order and dedups", () => {
    let state = EMPTY_CHAT_STREAM_STATE;
    state = reduceLive(state, opener(2), DETAILS);
    state = reduceLive(state, env(4, { kind: "text", text: "b" }), DETAILS);
    state = reduceLive(state, env(3, { kind: "text", text: "a" }), DETAILS);
    state = reduceLive(state, env(3, { kind: "text", text: "a" }), DETAILS);
    expect(state.buffer.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it("archives the segmented turns when a seq-0 event resets the buffer", () => {
    let state = EMPTY_CHAT_STREAM_STATE;
    state = reduceLive(state, opener(1), DETAILS);
    state = reduceLive(state, env(2, { kind: "text", text: "old turn" }), DETAILS);
    state = reduceLive(state, env(0, { kind: "status", phase: "fetching" }), DETAILS);

    expect(state.buffer.map((e) => e.seq)).toEqual([0]);
    expect(state.archivedTurns).toHaveLength(1);
    expect(state.archivedTurns[0].open).toBe(false);
    expect(state.archivedTurns[0].envelopes.map((e) => e.seq)).toEqual([2]);
  });

  it("keeps archived turns visible alongside the ones in the live buffer", () => {
    let state = EMPTY_CHAT_STREAM_STATE;
    state = reduceLive(state, opener(1), DETAILS);
    state = reduceLive(state, env(0, { kind: "status", phase: "fetching" }), DETAILS);
    state = reduceLive(state, opener(1), DETAILS);
    expect(allTurns(state, DETAILS)).toHaveLength(2);
  });
});

describe("mergeReplayIntoState", () => {
  it("merges the replay under live events and dedups by seq", () => {
    const state = reduceLive(EMPTY_CHAT_STREAM_STATE, env(3, { kind: "text", text: "live" }), DETAILS);
    const merged = mergeReplayIntoState(state, [opener(1), env(2, { kind: "text", text: "replay" }), env(3, { kind: "text", text: "replay dup" })]);
    expect(merged.buffer.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(merged.buffer[2].event).toEqual({ kind: "text", text: "replay dup" });
  });

  it("segments an interleaved run + chat buffer into the chat turns only", () => {
    const state = mergeReplayIntoState(EMPTY_CHAT_STREAM_STATE, [
      env(1, { kind: "status", phase: "fetching" }),
      env(2, { kind: "status", phase: "agent-start" }),
      env(3, { kind: "text", text: "run work" }),
      env(4, { kind: "result", ok: true }),
      opener(5),
      env(6, { kind: "text", text: "chat reply" }),
      env(7, { kind: "result", ok: true }),
    ]);
    const turns = allTurns(state, DETAILS);
    expect(turns).toHaveLength(1);
    expect(turns[0].envelopes.map((e) => e.seq)).toEqual([6, 7]);
  });
});
