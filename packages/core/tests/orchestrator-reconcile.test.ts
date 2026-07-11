import { describe, it, expect } from "vitest";
import type { Issue, LifecycleState, PullRequest, TrackedItem } from "@nestbrain/shared";
import {
  reconcile,
  admitItem,
  type OrchestratorManifest,
  type ReconcilePoll,
} from "../src/orchestrator";

const ACCOUNT = "acct-1";

function issue(n: number, overrides: Partial<Issue> = {}): Issue {
  return {
    id: `github:${n}`,
    kind: "issue",
    platform: "github",
    accountId: ACCOUNT,
    repo: { owner: "o", name: "r" },
    number: n,
    title: `Issue ${n}`,
    labels: [],
    assignees: [],
    url: `https://github.com/o/r/issues/${n}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

function pull(n: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `github:pr-${n}`,
    kind: "pull-request",
    platform: "github",
    accountId: ACCOUNT,
    repo: { owner: "o", name: "r" },
    number: n,
    title: `PR ${n}`,
    labels: [],
    assignees: [],
    url: `https://github.com/o/r/pull/${n}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    merged: false,
    draft: false,
    ...overrides,
  };
}

function manifest(): OrchestratorManifest {
  return { version: 1, settings: { intakePaused: false }, items: {}, parked: {} };
}

function tracked(n: number, state: LifecycleState, extra: Partial<TrackedItem> = {}): TrackedItem {
  return { ...admitItem(issue(n)), state, ...extra };
}

function poll(overrides: Partial<ReconcilePoll> = {}): ReconcilePoll {
  return { mode: "delta", issues: [], pullRequests: [], ...overrides };
}

const openPolicy = { intakePaused: false };

describe("reconcile — issues", () => {
  it("admits an unknown open issue into triage", () => {
    const m = manifest();
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), openPolicy);
    expect(outcome.admitted).toEqual(["github:1"]);
    expect(m.items["github:1"].state).toBe("triage");
    expect(outcome.transitions).toEqual([
      { itemId: "github:1", from: null, to: "triage", reason: "admitted" },
    ]);
  });

  it("respects shouldAdmit", () => {
    const m = manifest();
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), {
      intakePaused: false,
      shouldAdmit: () => false,
    });
    expect(outcome.admitted).toEqual([]);
    expect(m.items).toEqual({});
    expect(m.parked).toEqual({});
  });

  it("parks unknown open issues while intake is paused", () => {
    const m = manifest();
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), { intakePaused: true });
    expect(outcome.parked).toEqual(["github:1"]);
    expect(m.parked["github:1"]).toBeDefined();
    expect(m.items).toEqual({});
  });

  it("admits a previously parked issue once intake resumes", () => {
    const m = manifest();
    reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), { intakePaused: true });
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), openPolicy);
    expect(outcome.admitted).toEqual(["github:1"]);
    expect(m.parked).toEqual({});
  });

  it("ignores unknown closed issues and drops them from parked", () => {
    const m = manifest();
    m.parked["github:1"] = { firstSeenAt: "2026-07-11T09:00:00.000Z" };
    const outcome = reconcile(
      m,
      ACCOUNT,
      poll({ issues: [issue(1, { state: "closed" })] }),
      openPolicy,
    );
    expect(outcome.transitions).toEqual([]);
    expect(m.items).toEqual({});
    expect(m.parked).toEqual({});
  });

  it("closes a pre-coding item when its issue closes on GitHub", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage");
    const outcome = reconcile(
      m,
      ACCOUNT,
      poll({ issues: [issue(1, { state: "closed" })] }),
      openPolicy,
    );
    expect(m.items["github:1"].state).toBe("closed");
    expect(outcome.transitions[0]).toMatchObject({ to: "closed", reason: "closed on GitHub" });
  });

  it("treats a close after merge as a no-op", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "merged");
    const outcome = reconcile(
      m,
      ACCOUNT,
      poll({ issues: [issue(1, { state: "closed" })] }),
      openPolicy,
    );
    expect(m.items["github:1"].state).toBe("merged");
    expect(outcome.transitions).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
  });

  it("re-admits a reopened issue into triage", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "closed");
    reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), openPolicy);
    expect(m.items["github:1"].state).toBe("triage");
  });

  it("refreshes mirrored metadata without a transition", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "planning");
    const outcome = reconcile(
      m,
      ACCOUNT,
      poll({ issues: [issue(1, { title: "renamed" })] }),
      openPolicy,
    );
    expect(m.items["github:1"].title).toBe("renamed");
    expect(m.items["github:1"].state).toBe("planning");
    expect(outcome.transitions).toEqual([]);
  });
});

describe("reconcile — pull requests", () => {
  it("links an open PR to its issue via the branch heuristic", () => {
    const m = manifest();
    m.items["github:42"] = tracked(42, "human-review");
    reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(7, { headRef: "feature/issue-42-orchestrator" })] }),
      openPolicy,
    );
    expect(m.items["github:42"].pr).toEqual({
      id: "github:pr-7",
      number: 7,
      url: "https://github.com/o/r/pull/7",
    });
  });

  it("does not link PRs whose branch names no tracked issue", () => {
    const m = manifest();
    m.items["github:42"] = tracked(42, "triage");
    reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(7, { headRef: "feature/issue-99-other" })] }),
      openPolicy,
    );
    expect(m.items["github:42"].pr).toBeUndefined();
  });

  it("moves a linked item to merged when its PR merges", () => {
    const m = manifest();
    m.items["github:42"] = tracked(42, "in-review", {
      pr: { id: "github:pr-7", number: 7, url: "u" },
    });
    const outcome = reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(7, { state: "closed", merged: true })] }),
      openPolicy,
    );
    expect(m.items["github:42"].state).toBe("merged");
    expect(outcome.transitions[0]).toMatchObject({ to: "merged", reason: "PR merged" });
  });

  it("records a conflict when a PR merges while the item state cannot reach merged", () => {
    const m = manifest();
    m.items["github:42"] = tracked(42, "triage", {
      pr: { id: "github:pr-7", number: 7, url: "u" },
    });
    const outcome = reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(7, { state: "closed", merged: true })] }),
      openPolicy,
    );
    expect(m.items["github:42"].state).toBe("triage");
    expect(outcome.conflicts).toHaveLength(1);
  });

  it("moves a linked item to needs-input when its PR closes without merge", () => {
    const m = manifest();
    m.items["github:42"] = tracked(42, "in-review", {
      pr: { id: "github:pr-7", number: 7, url: "u" },
    });
    reconcile(m, ACCOUNT, poll({ pullRequests: [pull(7, { state: "closed" })] }), openPolicy);
    expect(m.items["github:42"].state).toBe("needs-input");
  });

  it("moves pr-open to in-review when the PR is open and not draft", () => {
    const m = manifest();
    m.items["github:42"] = tracked(42, "pr-open", {
      pr: { id: "github:pr-7", number: 7, url: "u" },
    });
    reconcile(m, ACCOUNT, poll({ pullRequests: [pull(7)] }), openPolicy);
    expect(m.items["github:42"].state).toBe("in-review");
  });

  it("moves in-review to changes-requested on reviewDecision", () => {
    const m = manifest();
    m.items["github:42"] = tracked(42, "pr-open", {
      pr: { id: "github:pr-7", number: 7, url: "u" },
    });
    const outcome = reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(7, { reviewDecision: "changes-requested" })] }),
      openPolicy,
    );
    // same tick: pr-open → in-review → changes-requested
    expect(outcome.transitions.map((t) => t.to)).toEqual(["in-review", "changes-requested"]);
    expect(m.items["github:42"].state).toBe("changes-requested");
  });

  it("ignores standalone PRs with no tracked issue", () => {
    const m = manifest();
    const outcome = reconcile(m, ACCOUNT, poll({ pullRequests: [pull(7)] }), openPolicy);
    expect(m.items).toEqual({});
    expect(outcome.transitions).toEqual([]);
  });
});

describe("reconcile — full-walk absence", () => {
  it("closes absent pre-coding items", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "queued");
    const outcome = reconcile(m, ACCOUNT, poll({ mode: "full" }), openPolicy);
    expect(m.items["github:1"].state).toBe("closed");
    expect(outcome.transitions[0]).toMatchObject({
      to: "closed",
      reason: "no longer assigned or visible",
    });
  });

  it("keeps absent in-flight items and records a conflict", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "coding");
    const outcome = reconcile(m, ACCOUNT, poll({ mode: "full" }), openPolicy);
    expect(m.items["github:1"].state).toBe("coding");
    expect(outcome.conflicts).toHaveLength(1);
  });

  it("leaves present items and other accounts alone", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "queued");
    m.items["github:2"] = { ...tracked(2, "queued"), accountId: "acct-2" };
    reconcile(m, ACCOUNT, poll({ mode: "full", issues: [issue(1)] }), openPolicy);
    expect(m.items["github:1"].state).toBe("queued");
    expect(m.items["github:2"].state).toBe("queued");
  });

  it("never infers absence in delta mode", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "queued");
    const outcome = reconcile(m, ACCOUNT, poll({ mode: "delta" }), openPolicy);
    expect(m.items["github:1"].state).toBe("queued");
    expect(outcome.conflicts).toEqual([]);
  });

  it("prunes parked ids absent from the full snapshot", () => {
    const m = manifest();
    m.parked["github:9"] = { firstSeenAt: "2026-07-11T09:00:00.000Z" };
    reconcile(m, ACCOUNT, poll({ mode: "full" }), openPolicy);
    expect(m.parked).toEqual({});
  });
});
