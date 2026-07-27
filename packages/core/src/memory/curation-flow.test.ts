import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolutionRecord } from "@skipper/shared";
import { memoryFileName, readSolutionRecord, writeSolutionRecord } from "./store";
import { applyFeedbackVote, feedbackWeight } from "./ranking";

// End-to-end of the desktop skipper:memory:curate path (#255) against the real
// on-disk store. Unlike the feedback path (#46) the idempotency anchor is the
// record's own curationVote, so no manifest is involved and records that no run
// ever consulted can still be curated. No Electron, no embedder.

let dir: string;

const record: SolutionRecord = {
  version: 1,
  itemId: "github:100",
  repo: { owner: "acme", name: "rocket" },
  issueNumber: 100,
  title: "fix the thing",
  url: "https://example.test/100",
  pr: { number: 7, url: "https://example.test/pr/7" },
  outcome: "merged",
  capturedAt: new Date().toISOString(),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skipper-curate-"));
  await writeSolutionRecord(dir, record);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Mirror the IPC handler: the stored curationVote is the old vote. */
async function curate(newVote: "up" | "down" | null) {
  const ref = memoryFileName(record.itemId);
  const rec = await readSolutionRecord(dir, ref);
  if (!rec) throw new Error("record vanished");
  const oldVote = rec.curationVote;
  if (oldVote === (newVote ?? undefined)) return rec;
  rec.feedback = applyFeedbackVote(rec.feedback, oldVote, newVote);
  if (newVote) rec.curationVote = newVote;
  else delete rec.curationVote;
  await writeSolutionRecord(dir, rec);
  return (await readSolutionRecord(dir, ref))!;
}

describe("memory curation persistence + ranking (#255)", () => {
  it("👍 persists the vote anchor and lifts the retrieval weight", async () => {
    const after = await curate("up");
    expect(after.feedback).toEqual({ up: 1, down: 0 });
    expect(after.curationVote).toBe("up");
    expect(feedbackWeight(after.feedback)).toBeGreaterThan(1);
  });

  it("up → down → null walks the counters back to neutral", async () => {
    await curate("up");
    const flipped = await curate("down");
    expect(flipped.feedback).toEqual({ up: 0, down: 1 });
    expect(flipped.curationVote).toBe("down");
    expect(feedbackWeight(flipped.feedback)).toBeLessThan(1);

    const cleared = await curate(null);
    expect(cleared.feedback).toEqual({ up: 0, down: 0 });
    expect(cleared.curationVote).toBeUndefined();
    expect(feedbackWeight(cleared.feedback)).toBe(1);
  });

  it("re-casting the same vote is a no-op, however many times", async () => {
    await curate("up");
    await curate("up");
    const after = await curate("up");
    expect(after.feedback).toEqual({ up: 1, down: 0 });
  });

  it("clearing an absent vote leaves the counters untouched", async () => {
    const after = await curate(null);
    expect(after.feedback).toBeUndefined();
    expect(after.curationVote).toBeUndefined();
  });

  it("curation stacks on top of counters accrued from run feedback", async () => {
    const seeded = (await readSolutionRecord(dir, memoryFileName(record.itemId)))!;
    seeded.feedback = { up: 3, down: 1 };
    await writeSolutionRecord(dir, seeded);

    const after = await curate("down");
    expect(after.feedback).toEqual({ up: 3, down: 2 });
  });
});
