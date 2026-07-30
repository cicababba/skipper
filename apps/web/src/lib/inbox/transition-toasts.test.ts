import { describe, expect, it } from "vitest";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/shared";
import type {
  IssueSourceCapabilities,
  IssueSourceId,
  LifecycleState,
  OrchestratorAccountState,
  OrchestratorState,
  PullRequest,
  TrackedItem,
} from "@skipper/shared";
import { diffTransitionToasts, itemLabel, trackedPull } from "./transition-toasts";

function item(overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "octo/repo", key: "1" },
    codeHost: "github",
    key: "1",
    accountId: "acc",
    repo: { owner: "octo", name: "repo" },
    number: 1,
    title: "fix the topbar",
    url: "https://github.com/octo/repo/issues/1",
    state: "triage",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    transitions: [],
    ...overrides,
  };
}

const PR = { id: "pr-1", number: 7, url: "https://github.com/octo/repo/pull/7" };

function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "github:pr:7",
    source: "github",
    sourceRef: { project: "octo/repo", key: "7" },
    codeHost: "github",
    accountId: "acc",
    kind: "pull-request",
    key: "7",
    title: "fix the topbar",
    labels: [],
    assignees: [],
    url: "https://github.com/octo/repo/pull/7",
    repo: { owner: "octo", name: "repo" },
    number: 7,
    state: "open",
    merged: false,
    draft: false,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function account(pullRequests: PullRequest[] = []): OrchestratorAccountState {
  return { accountId: "acc", status: "idle", issues: [], pullRequests };
}

const CAPABILITIES: Record<IssueSourceId, IssueSourceCapabilities> = {
  github: { closeIssue: true, createIssue: true },
  gitlab: { closeIssue: true, createIssue: true },
  jira: { closeIssue: false, createIssue: true },
  openproject: { closeIssue: true, createIssue: true },
  bitbucket: { closeIssue: false, createIssue: true },
};

function snapshot(items: TrackedItem[], pullRequests?: PullRequest[]): OrchestratorState {
  return {
    status: "idle",
    intakePaused: false,
    parkedCount: 0,
    queue: { coding: 0, queued: 0, wipLimitPerRepo: 1 },
    items,
    accounts: { acc: account(pullRequests) },
    repoSettings: {},
    projectMappings: {},
    unmappedProjects: [],
    resumeRite: null,
    settings: DEFAULT_ORCHESTRATOR_SETTINGS,
    sourceCapabilities: CAPABILITIES,
  };
}

/** prev/next pair where the single item moves from `from` to `to`. */
function move(from: LifecycleState, to: LifecycleState, overrides: Partial<TrackedItem> = {}) {
  return {
    prev: snapshot([item({ state: from })]),
    next: snapshot([item({ state: to, ...overrides })]),
  };
}

describe("itemLabel", () => {
  it("prefixes numeric keys with a hash", () => {
    expect(itemLabel(item())).toBe("#1 fix the topbar");
  });

  it("passes a Jira-style key through verbatim", () => {
    expect(itemLabel(item({ key: "PROJ-123" }))).toBe("PROJ-123 fix the topbar");
  });

  it("truncates a long label to 60 characters with an ellipsis", () => {
    const label = itemLabel(item({ title: "x".repeat(100) }));
    expect(label.length).toBe(60);
    expect(label.endsWith("…")).toBe(true);
    expect(label.startsWith("#1 xxx")).toBe(true);
  });

  it("leaves a label of exactly the limit untouched", () => {
    const title = "y".repeat(57);
    const label = itemLabel(item({ title }));
    expect(label).toBe(`#1 ${title}`);
    expect(label.length).toBe(60);
  });
});

describe("trackedPull", () => {
  it("finds the pull behind the item's link", () => {
    const tracked = item({ pr: PR });
    const state = snapshot([tracked], [pull({ ciStatus: "passing" })]);
    expect(trackedPull(state, tracked)?.ciStatus).toBe("passing");
  });

  it("returns nothing for an item without a PR", () => {
    const tracked = item();
    expect(trackedPull(snapshot([tracked], [pull()]), tracked)).toBeUndefined();
  });

  it("does not match the same PR number in another repo", () => {
    const tracked = item({ pr: PR });
    const other = pull({ repo: { owner: "octo", name: "other" } });
    expect(trackedPull(snapshot([tracked], [other]), tracked)).toBeUndefined();
  });
});

describe("diffTransitionToasts", () => {
  it("stays silent on the first snapshot, even with items already at the gate", () => {
    const first = snapshot([item({ state: "plan-gate" }), item({ id: "github:2", state: "needs-input" })]);
    expect(diffTransitionToasts(null, first)).toEqual([]);
  });

  it("reports a plan reaching the gate with its confidence", () => {
    const { prev, next } = move("planning", "plan-gate", { plan: { confidence: 0.82 } });
    expect(diffTransitionToasts(prev, next)).toEqual([
      { kind: "plan-gate", itemId: "github:1", label: "#1 fix the topbar", confidence: 0.82 },
    ]);
  });

  it("omits the confidence when the plan carries none", () => {
    const { prev, next } = move("planning", "plan-gate");
    expect(diffTransitionToasts(prev, next)).toEqual([
      { kind: "plan-gate", itemId: "github:1", label: "#1 fix the topbar" },
    ]);
  });

  it("reports a diff waiting in human review", () => {
    const { prev, next } = move("coding", "human-review");
    expect(diffTransitionToasts(prev, next)).toEqual([
      { kind: "human-review", itemId: "github:1", label: "#1 fix the topbar" },
    ]);
  });

  it("reports a first PR as opened, not a repush", () => {
    const { prev, next } = move("human-review", "pr-open", { pr: PR });
    expect(diffTransitionToasts(prev, next)).toEqual([
      {
        kind: "pr-open",
        itemId: "github:1",
        label: "#1 fix the topbar",
        prUrl: PR.url,
        repush: false,
      },
    ]);
  });

  it("reports a fix round landing on an existing PR as a repush", () => {
    const prev = snapshot([item({ state: "coding", pr: PR })]);
    const next = snapshot([item({ state: "pr-open", pr: PR })]);
    expect(diffTransitionToasts(prev, next)).toEqual([
      {
        kind: "pr-open",
        itemId: "github:1",
        label: "#1 fix the topbar",
        prUrl: PR.url,
        repush: true,
      },
    ]);
  });

  it("reports needs-input with the reason of the last transition", () => {
    const { prev, next } = move("coding", "needs-input", {
      transitions: [
        { at: "2026-07-01T00:00:00Z", from: "queued", to: "coding", actor: "system" },
        {
          at: "2026-07-01T01:00:00Z",
          from: "coding",
          to: "needs-input",
          actor: "coder",
          reason: "the coder run failed",
        },
      ],
    });
    expect(diffTransitionToasts(prev, next)).toEqual([
      {
        kind: "needs-input",
        itemId: "github:1",
        label: "#1 fix the topbar",
        reason: "the coder run failed",
      },
    ]);
  });

  it("reports needs-input without a reason when the transition has none", () => {
    const { prev, next } = move("coding", "needs-input");
    expect(diffTransitionToasts(prev, next)).toEqual([
      { kind: "needs-input", itemId: "github:1", label: "#1 fix the topbar" },
    ]);
  });

  it("reports changes requested on the PR", () => {
    const prev = snapshot([item({ state: "in-review", pr: PR })]);
    const next = snapshot([item({ state: "changes-requested", pr: PR })]);
    expect(diffTransitionToasts(prev, next)).toEqual([
      { kind: "changes-requested", itemId: "github:1", label: "#1 fix the topbar", prUrl: PR.url },
    ]);
  });

  it("reports a merge", () => {
    const prev = snapshot([item({ state: "in-review", pr: PR })]);
    const next = snapshot([item({ state: "merged", pr: PR })]);
    expect(diffTransitionToasts(prev, next)).toEqual([
      { kind: "merged", itemId: "github:1", label: "#1 fix the topbar", prUrl: PR.url },
    ]);
  });

  it("skips PR-bound events on an item that has no PR recorded", () => {
    const states: LifecycleState[] = ["pr-open", "changes-requested", "merged"];
    for (const state of states) {
      const { prev, next } = move("coding", state);
      expect(diffTransitionToasts(prev, next)).toEqual([]);
    }
  });

  it("stays silent on the routine transitions of the loop", () => {
    const noise: [LifecycleState, LifecycleState][] = [
      ["triage", "planning"],
      ["planning", "queued"],
      ["plan-gate", "queued"],
      ["queued", "coding"],
      ["coding", "agent-review"],
      ["agent-review", "coding"],
      ["pr-open", "in-review"],
      ["coding", "blocked"],
      ["coding", "failed"],
      ["in-review", "closed"],
    ];
    for (const [from, to] of noise) {
      const { prev, next } = move(from, to);
      expect(diffTransitionToasts(prev, next)).toEqual([]);
    }
  });

  it("stays silent when the same state is pushed again as a new object", () => {
    const prev = snapshot([item({ state: "plan-gate", plan: { confidence: 0.9 } })]);
    const next = snapshot([item({ state: "plan-gate", plan: { confidence: 0.9 } })]);
    expect(prev).not.toBe(next);
    expect(diffTransitionToasts(prev, next)).toEqual([]);
  });

  it("stays silent for an item that appears for the first time in any state", () => {
    const prev = snapshot([item()]);
    const next = snapshot([item(), item({ id: "github:2", key: "2", state: "plan-gate" })]);
    expect(diffTransitionToasts(prev, next)).toEqual([]);
  });

  it("does not crash when an item disappears from the snapshot", () => {
    const prev = snapshot([item(), item({ id: "github:2", key: "2", state: "coding" })]);
    const next = snapshot([item()]);
    expect(diffTransitionToasts(prev, next)).toEqual([]);
  });

  it("reports several items in the order of the new snapshot", () => {
    const prev = snapshot([
      item({ id: "github:1", key: "1", state: "coding" }),
      item({ id: "github:2", key: "2", state: "planning" }),
    ]);
    const next = snapshot([
      item({ id: "github:1", key: "1", state: "human-review" }),
      item({ id: "github:2", key: "2", state: "plan-gate" }),
    ]);
    expect(diffTransitionToasts(prev, next).map((e) => [e.itemId, e.kind])).toEqual([
      ["github:1", "human-review"],
      ["github:2", "plan-gate"],
    ]);
  });

  describe("CI failure", () => {
    function ciPair(before: PullRequest["ciStatus"], after: PullRequest["ciStatus"]) {
      const tracked = item({ state: "in-review", pr: PR });
      return {
        prev: snapshot([tracked], [pull({ ciStatus: before })]),
        next: snapshot([tracked], [pull({ ciStatus: after })]),
      };
    }

    it("fires when a pending run turns red", () => {
      const { prev, next } = ciPair("pending", "failing");
      expect(diffTransitionToasts(prev, next)).toEqual([
        { kind: "ci-failed", itemId: "github:1", label: "#1 fix the topbar", prUrl: PR.url },
      ]);
    });

    it("fires when a green run turns red", () => {
      const { prev, next } = ciPair("passing", "failing");
      expect(diffTransitionToasts(prev, next).map((e) => e.kind)).toEqual(["ci-failed"]);
    });

    it("stays silent while the run keeps failing", () => {
      const { prev, next } = ciPair("failing", "failing");
      expect(diffTransitionToasts(prev, next)).toEqual([]);
    });

    it("stays silent when a red run turns green", () => {
      const { prev, next } = ciPair("failing", "passing");
      expect(diffTransitionToasts(prev, next)).toEqual([]);
    });

    it("stays silent for a PR that is already red the first time it appears", () => {
      const tracked = item({ state: "in-review", pr: PR });
      const prev = snapshot([tracked], []);
      const next = snapshot([tracked], [pull({ ciStatus: "failing" })]);
      expect(diffTransitionToasts(prev, next)).toEqual([]);
    });

    it("stays silent when the item has no PR link", () => {
      const tracked = item({ state: "in-review" });
      const prev = snapshot([tracked], [pull({ ciStatus: "pending" })]);
      const next = snapshot([tracked], [pull({ ciStatus: "failing" })]);
      expect(diffTransitionToasts(prev, next)).toEqual([]);
    });

    it("reports both the state change and the CI failure in the same push", () => {
      const prev = snapshot([item({ state: "in-review", pr: PR })], [pull({ ciStatus: "pending" })]);
      const next = snapshot(
        [item({ state: "changes-requested", pr: PR })],
        [pull({ ciStatus: "failing" })],
      );
      expect(diffTransitionToasts(prev, next).map((e) => e.kind)).toEqual([
        "changes-requested",
        "ci-failed",
      ]);
    });
  });
});
