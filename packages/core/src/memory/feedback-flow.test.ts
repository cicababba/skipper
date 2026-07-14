import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolutionRecord } from "@skipper/shared";
import { memoryFileName, readSolutionRecord, writeSolutionRecord } from "./store";
import { applyFeedbackVote, feedbackWeight } from "./ranking";

// End-to-end of the desktop skipper:memory:feedback path (#46) against the real
// on-disk store: read record → applyFeedbackVote → write → read back, and the
// ranking weight moves accordingly. No Electron, no embedder.

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
  dir = await mkdtemp(join(tmpdir(), "skipper-fb-"));
  await writeSolutionRecord(dir, record);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Mirror the IPC handler: load, apply the delta, persist. */
async function vote(oldVote: "up" | "down" | undefined, newVote: "up" | "down" | null) {
  const ref = memoryFileName(record.itemId);
  const rec = await readSolutionRecord(dir, ref);
  if (!rec) throw new Error("record vanished");
  rec.feedback = applyFeedbackVote(rec.feedback, oldVote, newVote);
  await writeSolutionRecord(dir, rec);
  return (await readSolutionRecord(dir, ref))!;
}

describe("memory feedback persistence + ranking (#46)", () => {
  it("👍 persists and lifts the retrieval weight above neutral", async () => {
    const after = await vote(undefined, "up");
    expect(after.feedback).toEqual({ up: 1, down: 0 });
    expect(feedbackWeight(after.feedback)).toBeGreaterThan(1);
  });

  it("flip 👍→👎 nets a single move and drops the weight below neutral", async () => {
    await vote(undefined, "up");
    const after = await vote("up", "down");
    expect(after.feedback).toEqual({ up: 0, down: 1 });
    expect(feedbackWeight(after.feedback)).toBeLessThan(1);
  });

  it("toggling off returns to neutral", async () => {
    await vote(undefined, "up");
    const after = await vote("up", null);
    expect(after.feedback).toEqual({ up: 0, down: 0 });
    expect(feedbackWeight(after.feedback)).toBe(1);
  });
});
