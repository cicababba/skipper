import { describe, it, expect } from "vitest";
import type { Issue, LifecycleState, PullRequest, TrackedItem } from "@skipper/shared";
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
    source: "github",
    sourceRef: { project: "o/r", key: String(n) },
    codeHost: "github",
    accountId: ACCOUNT,
    repo: { owner: "o", name: "r" },
    key: String(n),
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
    source: "github",
    sourceRef: { project: "o/r", key: String(n) },
    codeHost: "github",
    accountId: ACCOUNT,
    repo: { owner: "o", name: "r" },
    key: String(n),
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
  return {
    version: 1,
    settings: { intakePaused: false },
    items: {},
    parked: {},
    repoSettings: {},
    projectMappings: {},
  } as OrchestratorManifest;
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

  it("admits a previously skipped issue once shouldAdmit flips (repo linked)", () => {
    const m = manifest();
    let linked = false;
    const policy = { intakePaused: false, shouldAdmit: () => linked };
    reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), policy);
    expect(m.items).toEqual({});
    linked = true;
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), policy);
    expect(outcome.admitted).toEqual(["github:1"]);
    expect(m.items["github:1"].state).toBe("triage");
  });

  it("parks unknown open issues while intake is paused", () => {
    const m = manifest();
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), { intakePaused: true });
    expect(outcome.parked).toEqual(["github:1"]);
    expect(m.parked["github:1"]).toBeDefined();
    expect(m.items).toEqual({});
  });

  it("neither admits nor parks a repo-less open issue, even while intake is paused (#79)", () => {
    const m = manifest();
    const repoLess = issue(1, { repo: undefined });
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [repoLess] }), { intakePaused: true });
    expect(outcome.admitted).toEqual([]);
    expect(outcome.parked).toEqual([]);
    expect(m.items).toEqual({});
    expect(m.parked).toEqual({});
  });

  it("still closes a tracked item when its now-repo-less issue closes on the tracker (#79)", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "coding");
    const repoLessClosed = issue(1, { repo: undefined, state: "closed" });
    reconcile(m, ACCOUNT, poll({ issues: [repoLessClosed] }), openPolicy);
    expect(m.items["github:1"].state).toBe("closed");
  });

  it("admits a previously parked issue once intake resumes", () => {
    const m = manifest();
    reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), { intakePaused: true });
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), openPolicy);
    expect(outcome.admitted).toEqual(["github:1"]);
    expect(m.parked).toEqual({});
  });

  it("ex-parked admission holds auto-plan and joins the resume rite (#15)", () => {
    const m = manifest();
    reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), { intakePaused: true });
    reconcile(m, ACCOUNT, poll({ issues: [issue(1), issue(2)] }), openPolicy);
    expect(m.items["github:1"].holdAutoPlan).toBe(true);
    expect(m.resumeRite?.itemIds).toEqual(["github:1"]);
    // never-parked sibling admitted in the same poll is not held
    expect(m.items["github:2"].holdAutoPlan).toBeUndefined();
  });

  it("resume rite dedupes item ids across polls", () => {
    const m = manifest();
    reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), { intakePaused: true });
    reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), openPolicy);
    // item closed + reopened while the rite is still pending → re-admission path
    delete m.items["github:1"];
    m.parked["github:1"] = { firstSeenAt: "2026-07-12T00:00:00.000Z" };
    reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), openPolicy);
    expect(m.resumeRite?.itemIds).toEqual(["github:1"]);
  });

  it("unfollowed issues are never parked while intake is paused (#15)", () => {
    const m = manifest();
    const outcome = reconcile(m, ACCOUNT, poll({ issues: [issue(1)] }), {
      intakePaused: true,
      shouldAdmit: () => false,
    });
    expect(outcome.parked).toEqual([]);
    expect(m.parked).toEqual({});
    expect(m.items).toEqual({});
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

  it("links a string-keyed item (Jira) via the slugged branch heuristic", () => {
    const m = manifest();
    m.items["jira:900"] = tracked(42, "human-review", {
      id: "jira:900",
      key: "PROJ-123",
      sourceRef: { project: "PROJ", key: "PROJ-123" },
    });
    reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(7, { headRef: "feature/issue-proj-123-fix-login" })] }),
      openPolicy,
    );
    expect(m.items["jira:900"].pr).toEqual({
      id: "github:pr-7",
      number: 7,
      url: "https://github.com/o/r/pull/7",
    });
  });

  it("does not link when the item key is only a string prefix of the branch slug", () => {
    const m = manifest();
    m.items["github:7"] = tracked(7, "triage");
    reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(9, { headRef: "feature/issue-71-two-axis" })] }),
      openPolicy,
    );
    expect(m.items["github:7"].pr).toBeUndefined();
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

  it("matches a linked item by repo + number even when the PR ids differ", () => {
    // openPr writes the pull-record id; the poll streams carry the issue-record id.
    const m = manifest();
    m.items["github:42"] = tracked(42, "in-review", {
      pr: { id: "github:555", number: 7, url: "u" },
    });
    reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(7, { id: "github:pr-7", state: "closed", merged: true })] }),
      openPolicy,
    );
    expect(m.items["github:42"].state).toBe("merged");
  });

  it("does not match a same-number PR from a different repo", () => {
    const m = manifest();
    m.items["github:42"] = tracked(42, "in-review", {
      pr: { id: "github:555", number: 7, url: "u" },
    });
    reconcile(
      m,
      ACCOUNT,
      poll({
        pullRequests: [
          pull(7, { repo: { owner: "other", name: "repo" }, state: "closed", merged: true }),
        ],
      }),
      openPolicy,
    );
    expect(m.items["github:42"].state).toBe("in-review");
  });

  it("ignores standalone PRs with no tracked issue", () => {
    const m = manifest();
    const outcome = reconcile(m, ACCOUNT, poll({ pullRequests: [pull(7)] }), openPolicy);
    expect(m.items).toEqual({});
    expect(outcome.transitions).toEqual([]);
  });
});

describe("reconcile — CI re-entry", () => {
  const SHA = "abc123";

  function ciManifest(state: LifecycleState, shepherd = {}): OrchestratorManifest {
    const m = manifest();
    (m.settings as { ciReentry?: string }).ciReentry = "auto";
    m.items["github:42"] = tracked(42, state, {
      pr: { id: "github:pr-7", number: 7, url: "u" },
      shepherd: { lastPushedSha: SHA, ...shepherd },
    });
    return m;
  }

  function failingPull(overrides: Partial<PullRequest> = {}): PullRequest {
    return pull(7, { draft: true, ciStatus: "failing", headSha: SHA, ...overrides });
  }

  it("re-enters changes-requested on a red CI over the agent's own push", () => {
    const m = ciManifest("pr-open");
    const outcome = reconcile(m, ACCOUNT, poll({ pullRequests: [failingPull()] }), openPolicy);
    expect(m.items["github:42"].state).toBe("changes-requested");
    expect(m.items["github:42"].shepherd).toMatchObject({ lastCiSha: SHA, ciFixRounds: 1 });
    expect(outcome.transitions[0].reason).toContain("CI failing");
  });

  it("reacts once per sha", () => {
    const m = ciManifest("pr-open", { lastCiSha: SHA, ciFixRounds: 1 });
    reconcile(m, ACCOUNT, poll({ pullRequests: [failingPull()] }), openPolicy);
    expect(m.items["github:42"].state).toBe("pr-open");
  });

  it("ignores a red CI on a human's push (headSha != lastPushedSha)", () => {
    const m = ciManifest("pr-open");
    reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [failingPull({ headSha: "human999" })] }),
      openPolicy,
    );
    expect(m.items["github:42"].state).toBe("pr-open");
    expect(m.items["github:42"].shepherd?.ciFixRounds).toBeUndefined();
  });

  it("is a no-op under ciReentry off", () => {
    const m = ciManifest("pr-open");
    (m.settings as { ciReentry?: string }).ciReentry = "off";
    reconcile(m, ACCOUNT, poll({ pullRequests: [failingPull()] }), openPolicy);
    expect(m.items["github:42"].state).toBe("pr-open");
  });

  it("parks at needs-input with resumeTo human-review past the round cap", () => {
    const m = ciManifest("pr-open", { lastCiSha: "prev", ciFixRounds: 2 });
    reconcile(m, ACCOUNT, poll({ pullRequests: [failingPull()] }), openPolicy);
    expect(m.items["github:42"].state).toBe("needs-input");
    expect(m.items["github:42"].resumeTo).toBe("human-review");
  });

  it("a green CI restores the round budget", () => {
    const m = ciManifest("pr-open", { lastCiSha: "prev", ciFixRounds: 2 });
    reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [failingPull({ ciStatus: "passing" })] }),
      openPolicy,
    );
    expect(m.items["github:42"].state).toBe("pr-open");
    expect(m.items["github:42"].shepherd?.ciFixRounds).toBeUndefined();
    expect(m.items["github:42"].shepherd?.lastCiSha).toBeUndefined();
  });

  it("respects a per-repo ciReentry override over the global off", () => {
    const m = ciManifest("pr-open");
    (m.settings as { ciReentry?: string }).ciReentry = "off";
    m.repoSettings["o/r"] = { ciReentry: "auto" };
    reconcile(m, ACCOUNT, poll({ pullRequests: [failingPull()] }), openPolicy);
    expect(m.items["github:42"].state).toBe("changes-requested");
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

describe("reconcile — dependencies (#85)", () => {
  const ref = (n: number, project = "o/r") => ({ project, key: String(n) });

  // A blocked item as reconcile would have left it (last transition into blocked
  // is reconcile-actored, "blocked by …"), so the release path is eligible.
  function reconcileBlocked(n: number, blockers: number[], resumeTo: LifecycleState = "triage") {
    return {
      ...tracked(n, "blocked", { blockedBy: blockers.map((b) => ref(b)), resumeTo }),
      transitions: [
        { at: "2026-07-01T00:00:00.000Z", from: null, to: "triage", actor: "reconcile", reason: "admitted" },
        {
          at: "2026-07-01T00:00:00.000Z",
          from: resumeTo,
          to: "blocked",
          actor: "reconcile",
          reason: `blocked by ${blockers.map((b) => `#${b}`).join(", ")}`,
        },
      ],
    } as TrackedItem;
  }

  it("parks a triage item with an unmet prerequisite, recording resumeTo + blockers", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "coding");
    m.items["github:2"] = tracked(2, "triage");
    reconcile(m, ACCOUNT, poll({ dependencies: { "github:2": [ref(1)] } }), openPolicy);
    expect(m.items["github:2"].state).toBe("blocked");
    expect(m.items["github:2"].resumeTo).toBe("triage");
    expect(m.items["github:2"].blockedBy).toEqual([ref(1)]);
    expect(m.items["github:2"].transitions.at(-1)?.reason).toBe("blocked by #1");
  });

  it("parks from plan-gate and queued too, resuming to the parked-from state", () => {
    for (const from of ["plan-gate", "queued"] as const) {
      const m = manifest();
      m.items["github:1"] = tracked(1, "coding");
      m.items["github:2"] = tracked(2, from, { blockedBy: [ref(1)] });
      reconcile(m, ACCOUNT, poll(), openPolicy);
      expect(m.items["github:2"].state).toBe("blocked");
      expect(m.items["github:2"].resumeTo).toBe(from);
    }
  });

  it("stores evidence but never parks an in-flight (coding) item", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage");
    m.items["github:2"] = tracked(2, "coding");
    reconcile(m, ACCOUNT, poll({ dependencies: { "github:2": [ref(1)] } }), openPolicy);
    expect(m.items["github:2"].state).toBe("coding");
    expect(m.items["github:2"].blockedBy).toEqual([ref(1)]);
  });

  it("does not park on an untracked, merged/closed, or self reference", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "merged");
    m.items["github:2"] = tracked(2, "triage", { blockedBy: [ref(1)] }); // merged → not blocking
    m.items["github:3"] = tracked(3, "triage", { blockedBy: [ref(99)] }); // untracked → ignored
    m.items["github:4"] = tracked(4, "triage", { blockedBy: [ref(4)] }); // self → ignored
    reconcile(m, ACCOUNT, poll(), openPolicy);
    expect(m.items["github:2"].state).toBe("triage");
    expect(m.items["github:3"].state).toBe("triage");
    expect(m.items["github:4"].state).toBe("triage");
  });

  it("resolves prerequisites case-insensitively", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "coding");
    m.items["github:2"] = tracked(2, "triage", { blockedBy: [ref(1, "O/R")] });
    reconcile(m, ACCOUNT, poll(), openPolicy);
    expect(m.items["github:2"].state).toBe("blocked");
    expect(m.items["github:2"].transitions.at(-1)?.reason).toBe("blocked by #1");
  });

  it("releases in the same round the prerequisite PR merges", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "in-review", { pr: { id: "p", number: 10, url: "u" } });
    m.items["github:2"] = reconcileBlocked(2, [1]);
    reconcile(
      m,
      ACCOUNT,
      poll({ pullRequests: [pull(10, { merged: true })] }),
      openPolicy,
    );
    expect(m.items["github:1"].state).toBe("merged");
    expect(m.items["github:2"].state).toBe("triage");
    expect(m.items["github:2"].transitions.at(-1)?.reason).toBe("prerequisites merged/closed");
  });

  it("releases in the same round the prerequisite issue closes", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage");
    m.items["github:2"] = reconcileBlocked(2, [1]);
    reconcile(m, ACCOUNT, poll({ issues: [issue(1, { state: "closed" })] }), openPolicy);
    expect(m.items["github:1"].state).toBe("closed");
    expect(m.items["github:2"].state).toBe("triage");
  });

  it("releases in the same round a full walk evicts the prerequisite", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage");
    m.items["github:2"] = reconcileBlocked(2, [1]);
    // Full walk: issue 1 absent (evicted → closed), issue 2 present (stays visible).
    reconcile(m, ACCOUNT, poll({ mode: "full", issues: [issue(2)] }), openPolicy);
    expect(m.items["github:1"].state).toBe("closed");
    expect(m.items["github:2"].state).toBe("triage");
  });

  it("empty evidence clears blockedBy and releases", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage");
    m.items["github:2"] = reconcileBlocked(2, [1]);
    reconcile(m, ACCOUNT, poll({ dependencies: { "github:2": [] } }), openPolicy);
    expect(m.items["github:2"].blockedBy).toBeUndefined();
    expect(m.items["github:2"].state).toBe("triage");
  });

  it("keeps blocked across a delta with no fresh evidence", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage");
    m.items["github:2"] = reconcileBlocked(2, [1]);
    reconcile(m, ACCOUNT, poll(), openPolicy); // no dependencies key
    expect(m.items["github:2"].state).toBe("blocked");
    expect(m.items["github:2"].blockedBy).toEqual([ref(1)]);
  });

  it("release preserves holdAutoPlan and falls back to triage without resumeTo", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "merged");
    m.items["github:2"] = {
      ...reconcileBlocked(2, [1]),
      holdAutoPlan: true,
      resumeTo: undefined,
    };
    reconcile(m, ACCOUNT, poll(), openPolicy);
    expect(m.items["github:2"].state).toBe("triage");
    expect(m.items["github:2"].holdAutoPlan).toBe(true);
  });

  it("waives the current unmet set on a user resume out of blocked instead of re-parking", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage");
    m.items["github:2"] = {
      ...tracked(2, "triage", { blockedBy: [ref(1)] }),
      transitions: [
        { at: "2026-07-01T00:00:00.000Z", from: null, to: "triage", actor: "reconcile", reason: "admitted" },
        { at: "2026-07-01T00:00:00.000Z", from: "triage", to: "blocked", actor: "reconcile", reason: "blocked by #1" },
        { at: "2026-07-01T00:00:00.000Z", from: "blocked", to: "triage", actor: "user", reason: "resume" },
      ],
    } as TrackedItem;
    reconcile(m, ACCOUNT, poll(), openPolicy);
    expect(m.items["github:2"].state).toBe("triage");
    expect(m.items["github:2"].blockedByWaived).toEqual([ref(1)]);
  });

  it("re-parks when a NEW unmet dep appears after the item moved past the resume", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage");
    m.items["github:3"] = tracked(3, "triage");
    m.items["github:2"] = {
      ...tracked(2, "plan-gate", { blockedBy: [ref(1), ref(3)], blockedByWaived: [ref(1)] }),
      transitions: [
        { at: "2026-07-01T00:00:00.000Z", from: null, to: "triage", actor: "reconcile", reason: "admitted" },
        { at: "2026-07-01T00:00:00.000Z", from: "planning", to: "plan-gate", actor: "planner", reason: "confidence" },
      ],
    } as TrackedItem;
    reconcile(m, ACCOUNT, poll(), openPolicy);
    expect(m.items["github:2"].state).toBe("blocked");
    expect(m.items["github:2"].resumeTo).toBe("plan-gate");
    expect(m.items["github:2"].transitions.at(-1)?.reason).toBe("blocked by #3");
  });

  it("does not auto-release a block a user created", () => {
    const m = manifest();
    m.items["github:2"] = {
      ...tracked(2, "blocked"),
      transitions: [
        { at: "2026-07-01T00:00:00.000Z", from: null, to: "triage", actor: "reconcile", reason: "admitted" },
        { at: "2026-07-01T00:00:00.000Z", from: "triage", to: "blocked", actor: "user", reason: "manual hold" },
      ],
    } as TrackedItem;
    reconcile(m, ACCOUNT, poll(), openPolicy);
    expect(m.items["github:2"].state).toBe("blocked");
  });

  it("parks both sides of a cycle and stays stable across a second poll", () => {
    const m = manifest();
    m.items["github:1"] = tracked(1, "triage", { blockedBy: [ref(2)] });
    m.items["github:2"] = tracked(2, "triage", { blockedBy: [ref(1)] });
    reconcile(m, ACCOUNT, poll(), openPolicy);
    expect(m.items["github:1"].state).toBe("blocked");
    expect(m.items["github:2"].state).toBe("blocked");
    reconcile(m, ACCOUNT, poll(), openPolicy);
    expect(m.items["github:1"].state).toBe("blocked");
    expect(m.items["github:2"].state).toBe("blocked");
  });
});
