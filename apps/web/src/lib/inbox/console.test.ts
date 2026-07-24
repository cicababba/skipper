import { describe, expect, it } from "vitest";
import type { CodingEventEnvelope } from "@skipper/shared";
import { appendLive, mergeReplay } from "./console";

function env(seq: number): CodingEventEnvelope {
  return {
    itemId: "github:1",
    seq,
    at: "2026-07-13T00:00:00.000Z",
    event: { kind: "text", text: `t${seq}` },
  };
}

describe("appendLive", () => {
  it("appends in seq order", () => {
    const list = appendLive(appendLive([], env(1)), env(2));
    expect(list.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("sorts an out-of-order arrival", () => {
    const list = appendLive([env(1), env(3)], env(2));
    expect(list.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("drops a duplicate seq", () => {
    const list = [env(1), env(2)];
    expect(appendLive(list, env(2))).toBe(list);
  });

  it("restarts the list on seq 0 (new run)", () => {
    const list = appendLive([env(5), env(6)], env(0));
    expect(list.map((e) => e.seq)).toEqual([0]);
  });
});

describe("mergeReplay", () => {
  it("merges overlapping live events without duplicates, sorted", () => {
    const live = [env(3), env(4)];
    const replay = [env(0), env(1), env(2), env(3)];
    const merged = mergeReplay(live, replay);
    expect(merged.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("handles an empty replay buffer", () => {
    expect(mergeReplay([env(1)], []).map((e) => e.seq)).toEqual([1]);
  });

  it("handles no live events yet", () => {
    expect(mergeReplay([], [env(0), env(1)]).map((e) => e.seq)).toEqual([0, 1]);
  });
});
