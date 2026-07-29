import { describe, it, expect, vi } from "vitest";
import {
  allCreated,
  initialCreateStates,
  pendingIndexes,
  runCreateFlow,
  type CardCreateState,
  type CreateOutcome,
} from "./create-flow";

const ok = (n: number): CreateOutcome => ({
  ok: true,
  id: `github:${n}`,
  number: n,
  url: `https://github.com/o/r/issues/${n}`,
});

describe("initialCreateStates", () => {
  it("marks every card pending", () => {
    expect(initialCreateStates(2)).toEqual({ 0: { status: "pending" }, 1: { status: "pending" } });
  });
});

describe("runCreateFlow", () => {
  it("posts the cards in order and reports each transition", async () => {
    const seen: [number, CardCreateState["status"]][] = [];
    const create = vi.fn(async (i: number) => ok(i + 1));
    const states = await runCreateFlow({
      indexes: [0, 1],
      create,
      onState: (i, s) => seen.push([i, s.status]),
    });
    expect(create.mock.calls.map(([i]) => i)).toEqual([0, 1]);
    expect(seen).toEqual([
      [0, "creating"],
      [0, "created"],
      [1, "creating"],
      [1, "created"],
    ]);
    expect(states[1]).toEqual({
      status: "created",
      number: 2,
      url: "https://github.com/o/r/issues/2",
    });
  });

  // Partial failure is the normal case: the tracker rejects one issue and the
  // rest must still land.
  it("keeps going after a failure and records it per card", async () => {
    const states = await runCreateFlow({
      indexes: [0, 1, 2],
      create: async (i) => (i === 1 ? { ok: false, error: "403" } : ok(i + 1)),
      onState: () => {},
    });
    expect(states[0].status).toBe("created");
    expect(states[1]).toEqual({ status: "failed", error: "403" });
    expect(states[2].status).toBe("created");
  });

  it("turns a thrown error into a failed card", async () => {
    const states = await runCreateFlow({
      indexes: [0],
      create: async () => {
        throw new Error("offline");
      },
      onState: () => {},
    });
    expect(states[0]).toEqual({ status: "failed", error: "offline" });
  });
});

describe("pendingIndexes", () => {
  it("skips cards already created so a retry never double-posts", () => {
    const states = {
      0: { status: "created" as const, url: "u", number: 1 },
      1: { status: "failed" as const, error: "403" },
      2: { status: "pending" as const },
    };
    expect(pendingIndexes(states, 3)).toEqual([1, 2]);
    expect(allCreated(states, 3)).toBe(false);
    expect(allCreated({ 0: states[0] }, 1)).toBe(true);
  });

  it("is never done with no cards at all", () => {
    expect(allCreated({}, 0)).toBe(false);
  });
});
