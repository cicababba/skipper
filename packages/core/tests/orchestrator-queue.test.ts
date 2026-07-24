import { describe, it, expect } from "vitest";
import { compareQueueCandidates, type QueueCandidate } from "../src/orchestrator";

function candidate(overrides: Partial<QueueCandidate> = {}): QueueCandidate {
  return {
    pinned: false,
    priority: "normal",
    queuedAt: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("compareQueueCandidates", () => {
  it("pinned beats priority, confidence and age", () => {
    const pinned = candidate({ pinned: true, priority: "low", queuedAt: "2026-07-12T00:00:00.000Z" });
    const scored = candidate({ priority: "high", confidence: 0.99, queuedAt: "2026-07-01T00:00:00.000Z" });
    expect(compareQueueCandidates(pinned, scored)).toBeLessThan(0);
    expect(compareQueueCandidates(scored, pinned)).toBeGreaterThan(0);
  });

  it("higher repo priority beats confidence", () => {
    const high = candidate({ priority: "high", confidence: 0.1 });
    const normal = candidate({ priority: "normal", confidence: 0.9 });
    expect(compareQueueCandidates(high, normal)).toBeLessThan(0);
  });

  it("low priority sorts after normal", () => {
    const low = candidate({ priority: "low" });
    const normal = candidate({ priority: "normal" });
    expect(compareQueueCandidates(normal, low)).toBeLessThan(0);
  });

  it("higher confidence wins within the same priority", () => {
    const strong = candidate({ confidence: 0.9, queuedAt: "2026-07-12T00:00:00.000Z" });
    const weak = candidate({ confidence: 0.5, queuedAt: "2026-07-01T00:00:00.000Z" });
    expect(compareQueueCandidates(strong, weak)).toBeLessThan(0);
  });

  it("missing confidence sorts below any scored candidate", () => {
    const unscored = candidate({ queuedAt: "2026-07-01T00:00:00.000Z" });
    const scored = candidate({ confidence: 0.01, queuedAt: "2026-07-12T00:00:00.000Z" });
    expect(compareQueueCandidates(scored, unscored)).toBeLessThan(0);
  });

  it("older queuedAt breaks ties", () => {
    const older = candidate({ queuedAt: "2026-07-01T00:00:00.000Z" });
    const newer = candidate({ queuedAt: "2026-07-12T00:00:00.000Z" });
    expect(compareQueueCandidates(older, newer)).toBeLessThan(0);
  });

  it("sorts a mixed queue in the documented order", () => {
    const items: Array<[string, QueueCandidate]> = [
      ["unscored-old", candidate({ queuedAt: "2026-07-01T00:00:00.000Z" })],
      ["pinned", candidate({ pinned: true, priority: "low" })],
      ["high-repo", candidate({ priority: "high" })],
      ["confident", candidate({ confidence: 0.8 })],
      ["less-confident", candidate({ confidence: 0.5 })],
    ];
    const order = items
      .slice()
      .sort((a, b) => compareQueueCandidates(a[1], b[1]))
      .map(([name]) => name);
    expect(order).toEqual(["pinned", "high-repo", "confident", "less-confident", "unscored-old"]);
  });
});
