import { describe, expect, it } from "vitest";
import type { SolutionRecord } from "@skipper/shared";
import { isStale, pruneCandidates, type PruneReason } from "./memory-review";

// The review queue (#256) only ever proposes: every threshold here exists to
// keep it from proposing something the user would have to defend a memory from.

const REPO = { owner: "acme", name: "rocket" };
const NOW = Date.parse("2026-07-20T00:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function record(itemId: string, overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 2,
    itemId,
    repo: REPO,
    title: `record ${itemId}`,
    url: "https://example.test/1",
    capturedAt: ago(30),
    ...overrides,
  };
}

const reasonsFor = (records: SolutionRecord[], id: string): PruneReason[] | undefined =>
  pruneCandidates(records, NOW).find((c) => c.record.itemId === id)?.reasons;

describe("isStale", () => {
  it("needs more than half the files gone", () => {
    expect(isStale(record("a", { staleness: 0.51 }))).toBe(true);
    expect(isStale(record("a", { staleness: 0.5 }))).toBe(false);
    expect(isStale(record("a", { staleness: 0 }))).toBe(false);
  });

  it("is false for a record that was never measured", () => {
    expect(isStale(record("a"))).toBe(false);
  });
});

describe("pruneCandidates — negative feedback", () => {
  it("flags a record the user voted down on enough evidence", () => {
    expect(reasonsFor([record("a", { feedback: { up: 0, down: 3 } })], "a")).toEqual([
      "negative-feedback",
    ]);
    expect(reasonsFor([record("a", { feedback: { up: 1, down: 4 } })], "a")).toEqual([
      "negative-feedback",
    ]);
  });

  it("holds its tongue below the volume gate — one bad day is not a verdict", () => {
    expect(reasonsFor([record("a", { feedback: { up: 0, down: 1 } })], "a")).toBeUndefined();
    expect(reasonsFor([record("a", { feedback: { up: 0, down: 2 } })], "a")).toBeUndefined();
  });

  it("ignores a record that is merely not loved", () => {
    expect(reasonsFor([record("a", { feedback: { up: 2, down: 2 } })], "a")).toBeUndefined();
    expect(reasonsFor([record("a", { feedback: { up: 5, down: 1 } })], "a")).toBeUndefined();
    expect(reasonsFor([record("a")], "a")).toBeUndefined();
  });
});

describe("pruneCandidates — staleness", () => {
  it("flags a record whose files are mostly gone", () => {
    expect(reasonsFor([record("a", { staleness: 0.9 })], "a")).toEqual(["stale"]);
  });

  it("leaves a half-stale or unmeasured record alone", () => {
    expect(reasonsFor([record("a", { staleness: 0.5 })], "a")).toBeUndefined();
    expect(reasonsFor([record("a")], "a")).toBeUndefined();
  });
});

// The rollout-safe rule: nothing on disk records when usage tracking started, so
// the repo's earliest offer stamp stands in for it.
describe("pruneCandidates — unused", () => {
  it("never flags when the repo has no offer stamps at all", () => {
    const records = [record("a", { capturedAt: ago(400) }), record("b", { capturedAt: ago(400) })];
    expect(pruneCandidates(records, NOW)).toEqual([]);
  });

  it("never flags on a fresh tracking baseline — day-one rollout is silent", () => {
    const records = [
      record("a", { capturedAt: ago(400), lastOfferedAt: ago(1) }),
      record("b", { capturedAt: ago(400) }),
    ];
    expect(pruneCandidates(records, NOW)).toEqual([]);
  });

  it("flags an old never-offered record once tracking itself is old enough", () => {
    // The baseline (earliest offer) is 200 days old and the repo is still
    // retrieving, so a never-offered old record inherits that baseline.
    const records = [
      record("baseline", { capturedAt: ago(400), lastOfferedAt: ago(200) }),
      record("active", { capturedAt: ago(400), lastOfferedAt: ago(5) }),
      record("never", { capturedAt: ago(400) }),
    ];
    expect(reasonsFor(records, "never")).toEqual(["unused"]);
    // The record that carries a recent offer of its own is left alone.
    expect(reasonsFor(records, "active")).toBeUndefined();
  });

  it("flags a record whose own last offer is older than six months", () => {
    const records = [
      record("a", { capturedAt: ago(400), lastOfferedAt: ago(200) }),
      record("b", { capturedAt: ago(400), lastOfferedAt: ago(2) }),
    ];
    expect(reasonsFor(records, "a")).toEqual(["unused"]);
  });

  // The amend fix: capture time counts too, so a young record can never be
  // "unused" just because the repo has been tracking for a year.
  it("never flags a record younger than six months, however old the baseline", () => {
    const records = [
      record("old", { capturedAt: ago(400), lastOfferedAt: ago(300) }),
      record("active", { capturedAt: ago(400), lastOfferedAt: ago(1) }),
      record("young", { capturedAt: ago(30) }),
    ];
    expect(reasonsFor(records, "young")).toBeUndefined();
    expect(reasonsFor(records, "old")).toEqual(["unused"]);
  });

  it("flags a never-offered record the moment it is itself six months old", () => {
    const base = [
      record("baseline", { capturedAt: ago(400), lastOfferedAt: ago(300) }),
      record("active", { capturedAt: ago(400), lastOfferedAt: ago(1) }),
    ];
    expect(reasonsFor([...base, record("x", { capturedAt: ago(179) })], "x")).toBeUndefined();
    expect(reasonsFor([...base, record("x", { capturedAt: ago(181) })], "x")).toEqual(["unused"]);
  });

  it("says nothing about a repo that is not retrieving memories at all", () => {
    const records = [
      record("a", { capturedAt: ago(400), lastOfferedAt: ago(300) }),
      record("b", { capturedAt: ago(400), lastOfferedAt: ago(280) }),
    ];
    expect(pruneCandidates(records, NOW)).toEqual([]);
  });

  it("treats an unparseable offer stamp as no stamp", () => {
    const records = [
      record("a", { capturedAt: ago(400), lastOfferedAt: "not-a-date" }),
      record("b", { capturedAt: ago(400), lastOfferedAt: "also junk" }),
    ];
    expect(pruneCandidates(records, NOW)).toEqual([]);
  });
});

describe("pruneCandidates — the dismiss window", () => {
  it("hides a candidate kept less than 90 days ago", () => {
    const rec = record("a", { staleness: 0.9, reviewDismissedAt: ago(89) });
    expect(pruneCandidates([rec], NOW)).toEqual([]);
  });

  it("lets it back in once the window has passed", () => {
    const rec = record("a", { staleness: 0.9, reviewDismissedAt: ago(91) });
    expect(reasonsFor([rec], "a")).toEqual(["stale"]);
  });

  it("hides it whatever the reason", () => {
    const rec = record("a", {
      feedback: { up: 0, down: 5 },
      staleness: 1,
      reviewDismissedAt: ago(1),
    });
    expect(pruneCandidates([rec], NOW)).toEqual([]);
  });

  it("ignores an unparseable dismissal stamp", () => {
    const rec = record("a", { staleness: 0.9, reviewDismissedAt: "whenever" });
    expect(reasonsFor([rec], "a")).toEqual(["stale"]);
  });
});

describe("pruneCandidates — the result", () => {
  it("accumulates every reason that applies, in a stable order", () => {
    const records = [
      record("a", {
        capturedAt: ago(400),
        feedback: { up: 0, down: 4 },
        staleness: 0.8,
      }),
      record("active", { capturedAt: ago(400), lastOfferedAt: ago(1) }),
      record("baseline", { capturedAt: ago(400), lastOfferedAt: ago(300) }),
    ];
    expect(reasonsFor(records, "a")).toEqual(["negative-feedback", "unused", "stale"]);
  });

  it("carries the record itself, and only the flagged ones", () => {
    const flagged = record("a", { staleness: 0.9 });
    const fine = record("b");
    const candidates = pruneCandidates([flagged, fine], NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].record).toBe(flagged);
  });

  it("returns [] for an empty repo", () => {
    expect(pruneCandidates([], NOW)).toEqual([]);
  });

  it("flags notes on the same rules as captured solutions", () => {
    const note = record("note:1", {
      kind: "note",
      note: { body: "b" },
      feedback: { up: 0, down: 3 },
    });
    expect(reasonsFor([note], "note:1")).toEqual(["negative-feedback"]);
  });
});
