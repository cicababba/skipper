import { describe, it, expect } from "vitest";
import { ApiError, AuthError, DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/core";
import type { OrchestratorManifest } from "@skipper/core";
import type { Issue, OrchestratorAccountState, RepoIntakeSettings, RepoRef } from "@skipper/shared";
import { admissionPolicy, shouldSkipPoll, selectPollCursor, pollFailurePatch } from "./poll-policy";

function state(patch: Partial<OrchestratorAccountState> = {}): OrchestratorAccountState {
  return { accountId: "acct", status: "idle", issues: [], pullRequests: [], ...patch };
}

function manifest(repoSettings: Record<string, RepoIntakeSettings> = {}): OrchestratorManifest {
  return {
    version: 3,
    settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS },
    items: {},
    parked: {},
    repoSettings,
    projectMappings: {},
  };
}

function issue(repo?: RepoRef): Issue {
  return {
    kind: "issue",
    id: "github:1",
    source: "github",
    sourceRef: { project: "octo/demo", key: "1" },
    codeHost: "github",
    accountId: "github:1",
    repo,
    key: "1",
    title: "t",
    labels: [],
    assignees: [],
    url: "https://github.com/octo/demo/issues/1",
    state: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

// Following is an explicit set (#15): a repo the poller merely happened to see
// admits nothing until the user chooses it.
describe("admissionPolicy", () => {
  it("does not admit an issue on a repo with no settings record", () => {
    expect(admissionPolicy(manifest()).shouldAdmit(issue({ owner: "octo", name: "demo" }))).toBe(
      false,
    );
  });

  it("admits an issue on an explicitly followed repo", () => {
    const policy = admissionPolicy(manifest({ "octo/demo": { followed: true } }));
    expect(policy.shouldAdmit(issue({ owner: "Octo", name: "Demo" }))).toBe(true);
  });

  it("does not admit an issue on an explicitly unfollowed repo", () => {
    const policy = admissionPolicy(manifest({ "octo/demo": { followed: false } }));
    expect(policy.shouldAdmit(issue({ owner: "octo", name: "demo" }))).toBe(false);
  });

  it("never admits a repo-less issue", () => {
    expect(admissionPolicy(manifest()).shouldAdmit(issue(undefined))).toBe(false);
  });

  it("mirrors the manifest's intakePaused", () => {
    const m = manifest();
    m.settings.intakePaused = true;
    expect(admissionPolicy(m).intakePaused).toBe(true);
  });
});

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
