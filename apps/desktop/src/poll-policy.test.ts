import { describe, it, expect } from "vitest";
import { ApiError, AuthError } from "@skipper/core";
import type { OrchestratorAccountState } from "@skipper/shared";
import { shouldSkipPoll, selectPollCursor, pollFailurePatch } from "./poll-policy";

function state(patch: Partial<OrchestratorAccountState> = {}): OrchestratorAccountState {
  return { accountId: "acct", status: "idle", issues: [], pullRequests: [], ...patch };
}

describe("shouldSkipPoll", () => {
  it("skips while nextPollAt is still in the future", () => {
    expect(shouldSkipPoll(state({ nextPollAt: 2000 }), 1000, false)).toBe(true);
  });

  it("polls once nextPollAt has passed", () => {
    expect(shouldSkipPoll(state({ nextPollAt: 1000 }), 2000, false)).toBe(false);
  });

  it("polls when there is no backoff set", () => {
    expect(shouldSkipPoll(state(), 1000, false)).toBe(false);
    expect(shouldSkipPoll(undefined, 1000, false)).toBe(false);
  });

  it("ignoreBackoff overrides an active backoff", () => {
    expect(shouldSkipPoll(state({ nextPollAt: 2000 }), 1000, true)).toBe(false);
  });
});

describe("selectPollCursor", () => {
  it("resumes the delta from the stored cursor when the walk is recent", () => {
    const r = selectPollCursor({
      now: 5000,
      lastFullWalkAt: 4000,
      storedCursor: "cur-1",
      fullWalkEveryMs: 10_000,
    });
    expect(r).toEqual({ forceFull: false, cursor: "cur-1" });
  });

  it("forces a full walk with no cursor once the last walk aged out", () => {
    const r = selectPollCursor({
      now: 20_000,
      lastFullWalkAt: 4000,
      storedCursor: "cur-1",
      fullWalkEveryMs: 10_000,
    });
    expect(r).toEqual({ forceFull: true, cursor: undefined });
  });

  it("forces a full walk when never walked (lastFullWalkAt 0)", () => {
    const r = selectPollCursor({
      now: 20_000,
      lastFullWalkAt: 0,
      storedCursor: undefined,
      fullWalkEveryMs: 10_000,
    });
    expect(r).toEqual({ forceFull: true, cursor: undefined });
  });
});

describe("pollFailurePatch", () => {
  it("parks an AuthError with no backoff", () => {
    expect(pollFailurePatch(new AuthError("re-auth"), 1000)).toEqual({
      status: "auth-error",
      error: "re-auth",
    });
  });

  it("schedules the next poll from an ApiError retryAfterSeconds", () => {
    expect(pollFailurePatch(new ApiError("rate limited", 429, undefined, 30), 1000)).toEqual({
      status: "error",
      error: "rate limited",
      nextPollAt: 1000 + 30 * 1000,
    });
  });

  it("treats an ApiError without retryAfterSeconds as a generic error", () => {
    const patch = pollFailurePatch(new ApiError("boom", 500), 1000);
    expect(patch.status).toBe("error");
    expect(patch.nextPollAt).toBeUndefined();
  });

  it("stringifies a generic error", () => {
    expect(pollFailurePatch(new Error("nope"), 1000)).toEqual({
      status: "error",
      error: "Error: nope",
    });
  });
});
