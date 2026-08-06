import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiError, AuthError, DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/core";
import type { IssueSource, OrchestratorManifest } from "@skipper/core";
import type { Account, Issue, PullRequest, SourceRef } from "@skipper/shared";
import type { InboxCursorFile } from "./inbox-cursor-store";
import { makePoller, type Poller, type PollerDeps } from "./poll";

// issueSourceForAuthProvider reaches the real adapter registry (network polls),
// so the source is the one piece of core the poller tests replace.
const hoisted = vi.hoisted(() => ({ source: undefined as IssueSource | undefined }));

vi.mock("@skipper/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skipper/core")>();
  return { ...actual, issueSourceForAuthProvider: () => hoisted.source };
});

const account: Account = {
  provider: "github",
  key: "github:1",
  id: "1",
  name: "cicababba",
};

const otherAccount: Account = {
  provider: "github",
  key: "github:2",
  id: "2",
  name: "someone-else",
};

function issue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    kind: "issue",
    source: "github",
    sourceRef: { project: "acme/widgets", key: overrides.key ?? "1" },
    codeHost: "github",
    accountId: account.key,
    repo: { owner: "acme", name: "widgets" },
    key: "1",
    number: 1,
    title: "an issue",
    labels: [],
    assignees: [],
    url: "https://github.com/acme/widgets/issues/1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequest> & { id: string }): PullRequest {
  return {
    kind: "pull-request",
    source: "github",
    sourceRef: { project: "acme/widgets", key: String(overrides.number ?? 7) },
    codeHost: "github",
    accountId: account.key,
    repo: { owner: "acme", name: "widgets" },
    key: String(overrides.number ?? 7),
    number: 7,
    title: "a pull request",
    labels: [],
    assignees: [],
    url: "https://github.com/acme/widgets/pull/7",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    merged: false,
    draft: false,
    ...overrides,
  };
}

function tracked(
  id: string,
  key: string,
  state: string,
  extra: Record<string, unknown> = {},
): OrchestratorManifest["items"][string] {
  return {
    ...issue({ id, key }),
    state,
    transitions: [],
    ...extra,
  } as unknown as OrchestratorManifest["items"][string];
}

function manifest(overrides: Partial<OrchestratorManifest> = {}): OrchestratorManifest {
  return {
    version: 3,
    settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS },
    items: {},
    parked: {},
    repoSettings: { "acme/widgets": { followed: true } },
    projectMappings: {},
    ...overrides,
  };
}

interface PollResult {
  mode: "full" | "delta";
  issues: Issue[];
  pullRequests: PullRequest[];
  cursor: unknown;
}

interface SetupOptions {
  accounts?: Account[];
  manifest?: OrchestratorManifest;
  cursors?: InboxCursorFile;
  results?: PollResult[];
  pollThrows?: unknown;
  fetchDependencies?: (issue: Issue) => Promise<SourceRef[]>;
  codeHostAccountFor?: PollerDeps["codeHostAccountFor"];
  now?: () => number;
}

interface Harness {
  poller: Poller;
  deps: PollerDeps;
  m: OrchestratorManifest;
  cursors: InboxCursorFile;
  poll: ReturnType<typeof vi.fn>;
  fetchDependencies: ReturnType<typeof vi.fn> | undefined;
  saveCursors: ReturnType<typeof vi.fn>;
  saveManifest: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  pokeDrivers: ReturnType<typeof vi.fn>;
  cancelPlanningRun: ReturnType<typeof vi.fn>;
  sweepStaleness: ReturnType<typeof vi.fn>;
  reactToMerges: ReturnType<typeof vi.fn>;
}

function setup(opts: SetupOptions = {}): Harness {
  const m = opts.manifest ?? manifest();
  const cursors = opts.cursors ?? { version: 2 as const, platforms: {} };
  const results = opts.results ?? [
    { mode: "full" as const, issues: [], pullRequests: [], cursor: "c1" },
  ];
  let call = 0;
  const poll = vi.fn(async () => {
    if (opts.pollThrows) throw opts.pollThrows;
    return results[Math.min(call++, results.length - 1)];
  });
  const fetchDependencies = opts.fetchDependencies
    ? vi.fn(
        async (
          iss: Issue,
          _getToken: unknown,
          _baseUrl?: string,
          _cloudId?: string,
          _authMethod?: "oauth" | "pat",
        ) => opts.fetchDependencies!(iss),
      )
    : undefined;
  hoisted.source = {
    id: "github",
    poll,
    ...(fetchDependencies ? { fetchDependencies } : {}),
  } as unknown as IssueSource;

  const saveCursors = vi.fn(async () => {});
  const saveManifest = vi.fn(async () => {});
  const broadcast = vi.fn();
  const pokeDrivers = vi.fn();
  const cancelPlanningRun = vi.fn();
  const sweepStaleness = vi.fn();
  const reactToMerges = vi.fn();
  const deps: PollerDeps = {
    getAccounts: () => opts.accounts ?? [account],
    getToken: async () => "tok",
    codeHostAccountFor: opts.codeHostAccountFor ?? (() => undefined),
    loadCursors: async () => cursors,
    saveCursors,
    ensureManifest: async () => m,
    saveManifest,
    ensureRepoLinks: async () => ({}),
    broadcast,
    pokeDrivers,
    cancelPlanningRun,
    sweepStaleness,
    reactToMerges,
    ...(opts.now ? { now: opts.now } : {}),
  };
  return {
    poller: makePoller(deps),
    deps,
    m,
    cursors,
    poll,
    fetchDependencies,
    saveCursors,
    saveManifest,
    broadcast,
    pokeDrivers,
    cancelPlanningRun,
    sweepStaleness,
    reactToMerges,
  };
}

beforeEach(() => {
  hoisted.source = undefined;
  vi.clearAllMocks();
});

describe("makePoller — cursor selection", () => {
  it("passes the stored delta cursor while the last full walk is fresh", async () => {
    const h = setup({
      cursors: { version: 2, platforms: { github: { "github:1": "stored" } } },
      now: () => 1_000,
    });
    await h.poller.pollNow();
    expect(h.poll.mock.calls[0]![0]).toMatchObject({ cursor: "stored" });
  });

  it("drops the stored cursor once the full-walk interval elapsed", async () => {
    const SIX_HOURS = 6 * 60 * 60_000;
    let clock = SIX_HOURS + 1;
    const h = setup({
      cursors: { version: 2, platforms: { github: { "github:1": "stored" } } },
      results: [
        { mode: "full", issues: [], pullRequests: [], cursor: "c1" },
        { mode: "delta", issues: [], pullRequests: [], cursor: "c2" },
      ],
      now: () => clock,
    });
    // No recorded full walk (lastFullWalkAt = 0) and past the window → forced full.
    await h.poller.pollNow();
    expect(h.poll.mock.calls[0]![0]).toMatchObject({ cursor: undefined });
    // A full result records the walk, so the next poll resumes from the cursor.
    clock += 1_000;
    await h.poller.pollNow();
    expect(h.poll.mock.calls[1]![0]).toMatchObject({ cursor: "c1" });
    // Past the 6h window the cursor is dropped again.
    clock += SIX_HOURS;
    await h.poller.pollNow();
    expect(h.poll.mock.calls[2]![0]).toMatchObject({ cursor: undefined });
  });

  it("skips an account inside its backoff window unless the caller forces it", async () => {
    let clock = 1_000;
    const h = setup({
      pollThrows: new ApiError("rate limited", 429, undefined, 60),
      now: () => clock,
    });
    await h.poller.pollNow();
    expect(h.poller.accountsState()["github:1"]!.nextPollAt).toBe(61_000);

    h.poll.mockClear();
    clock = 2_000;
    await h.poller.pollNow();
    expect(h.poll).not.toHaveBeenCalled();

    await h.poller.pollNow(true);
    expect(h.poll).toHaveBeenCalledTimes(1);
  });
});

describe("makePoller — raw cache", () => {
  it("evicts the same PR arriving under a different record id", async () => {
    const h = setup({
      results: [
        {
          mode: "full",
          issues: [],
          pullRequests: [pullRequest({ id: "github:issue-record" })],
          cursor: "c1",
        },
        {
          mode: "delta",
          issues: [],
          pullRequests: [pullRequest({ id: "github:pull-record" })],
          cursor: "c2",
        },
      ],
    });
    await h.poller.pollNow();
    await h.poller.pollNow();

    const cached = [...h.poller.allCached()];
    expect(cached).toHaveLength(1);
    expect(cached[0]!.id).toBe("github:pull-record");
  });

  it("keeps a PR from another repo with the same number", async () => {
    const h = setup({
      results: [
        {
          mode: "full",
          issues: [],
          pullRequests: [
            pullRequest({ id: "github:a" }),
            pullRequest({ id: "github:b", repo: { owner: "acme", name: "gadgets" } }),
          ],
          cursor: "c1",
        },
      ],
    });
    await h.poller.pollNow();
    expect([...h.poller.allCached()].map((i) => i.id).sort()).toEqual(["github:a", "github:b"]);
  });

  it("drops closed issues from the cache but keeps closed and merged PRs", async () => {
    const h = setup({
      results: [
        {
          mode: "full",
          issues: [issue({ id: "github:open" }), issue({ id: "github:done", state: "closed" })],
          pullRequests: [
            pullRequest({ id: "github:pr-closed", number: 8, state: "closed" }),
            pullRequest({ id: "github:pr-merged", number: 9, state: "closed", merged: true }),
          ],
          cursor: "c1",
        },
      ],
    });
    await h.poller.pollNow();
    expect([...h.poller.allCached()].map((i) => i.id).sort()).toEqual([
      "github:open",
      "github:pr-closed",
      "github:pr-merged",
    ]);
  });

  it("exposes the cache per account and drops a single item on untrack", async () => {
    const h = setup({
      results: [
        {
          mode: "full",
          issues: [issue({ id: "github:a" }), issue({ id: "github:b", key: "2", number: 2 })],
          pullRequests: [],
          cursor: "c1",
        },
      ],
    });
    await h.poller.pollNow();
    expect(h.poller.getCached("github:1", "github:a")?.id).toBe("github:a");
    expect(h.poller.cachedFor("github:1")?.size).toBe(2);
    expect([...h.poller.cachedByAccount()].map(([key]) => key)).toEqual(["github:1"]);

    h.broadcast.mockClear();
    h.poller.dropCached("github:1", "github:a");
    expect(h.poller.getCached("github:1", "github:a")).toBeUndefined();
    expect(h.poller.accountsState()["github:1"]!.issues.map((i) => i.id)).toEqual(["github:b"]);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it("flips a cached issue to closed and re-derives the account arrays", async () => {
    const h = setup({
      results: [
        { mode: "full", issues: [issue({ id: "github:a" })], pullRequests: [], cursor: "c1" },
      ],
    });
    await h.poller.pollNow();
    h.poller.markCachedIssueClosed("github:1", "github:a");
    expect(h.poller.getCached("github:1", "github:a")).toMatchObject({ state: "closed" });
    expect(h.poller.accountsState()["github:1"]!.issues[0]).toMatchObject({ state: "closed" });
  });

  it("ignores markCachedIssueClosed for a pull request", async () => {
    const h = setup({
      results: [
        { mode: "full", issues: [], pullRequests: [pullRequest({ id: "github:pr" })], cursor: "c1" },
      ],
    });
    await h.poller.pollNow();
    h.poller.markCachedIssueClosed("github:1", "github:pr");
    expect(h.poller.getCached("github:1", "github:pr")).toMatchObject({ state: "open" });
  });
});

describe("makePoller — dependency fetching (#85)", () => {
  function candidates(count: number): Issue[] {
    return Array.from({ length: count }, (_, i) =>
      issue({ id: `github:${i}`, key: String(i), number: i }),
    );
  }

  it("caps the fan-out at DEP_FETCH_CAP and fetches admission candidates first", async () => {
    // 35 candidates, the first one already tracked → the untracked admission
    // candidates go first and the fetch stops at 30 targets.
    const issues = candidates(35);
    const m = manifest({
      items: {
        "github:0": {
          ...issues[0]!,
          state: "triage",
          transitions: [],
        } as unknown as OrchestratorManifest["items"][string],
      },
    });
    const h = setup({
      manifest: m,
      results: [{ mode: "full", issues, pullRequests: [], cursor: "c1" }],
      fetchDependencies: async () => [],
    });
    await h.poller.pollNow();

    expect(h.fetchDependencies).toHaveBeenCalledTimes(30);
    const targets = h.fetchDependencies!.mock.calls.map((c) => (c[0] as Issue).id);
    expect(targets[0]).toBe("github:1");
    expect(targets).not.toContain("github:0");
  });

  it("passes the account's baseUrl, cloudId and authMethod through (#299)", async () => {
    const jiraAccount: Account = {
      provider: "jira",
      key: "github:1",
      id: "1",
      name: "cicababba",
      baseUrl: "https://acme.atlassian.net",
      cloudId: "cloud-1",
      authMethod: "pat",
    };
    const h = setup({
      accounts: [jiraAccount],
      results: [{ mode: "full", issues: candidates(1), pullRequests: [], cursor: "c1" }],
      fetchDependencies: async () => [],
    });
    await h.poller.pollNow();

    const call = h.fetchDependencies!.mock.calls[0]!;
    expect(call[2]).toBe("https://acme.atlassian.net");
    expect(call[3]).toBe("cloud-1");
    expect(call[4]).toBe("pat");
  });

  // #307: the retroactive-admission path (repo link/clone, follow toggle, intake
  // resume) used to reconcile with no dependency evidence at all, so a blocked
  // issue was admitted blind and the planner promoted it on the same tick.
  it("reconcileFromCache fetches evidence and parks a freshly admitted blocked issue", async () => {
    const m = manifest({ repoSettings: {} }); // unfollowed → the poll admits nothing
    const issues = [
      issue({ id: "github:a", key: "1", number: 1 }),
      issue({ id: "github:b", key: "2", number: 2 }),
    ];
    const h = setup({
      manifest: m,
      results: [{ mode: "full", issues, pullRequests: [], cursor: "c1" }],
      fetchDependencies: async (iss) =>
        iss.id === "github:b" ? [{ project: "acme/widgets", key: "1" }] : [],
    });
    await h.poller.pollNow();
    expect(h.fetchDependencies).not.toHaveBeenCalled();
    expect(m.items).toEqual({});

    m.repoSettings["acme/widgets"] = { followed: true };
    await h.poller.reconcileFromCache();

    expect(h.fetchDependencies).toHaveBeenCalledTimes(2);
    expect(m.items["github:a"]!.state).toBe("triage");
    expect(m.items["github:b"]!.state).toBe("blocked");
    expect(m.items["github:b"]!.resumeTo).toBe("triage");
    expect(m.items["github:b"]!.transitions.at(-1)?.reason).toBe("blocked by #1");
    expect(h.saveManifest).toHaveBeenCalled();
  });

  it("frees the planning slot of an item reconcile parked out of planning", async () => {
    const m = manifest({
      items: {
        "github:a": tracked("github:a", "1", "coding"),
        "github:b": tracked("github:b", "2", "planning", {
          blockedBy: [{ project: "acme/widgets", key: "1" }],
        }),
      },
    });
    const h = setup({
      manifest: m,
      results: [{ mode: "delta", issues: [], pullRequests: [], cursor: "c1" }],
    });
    await h.poller.pollNow();

    expect(m.items["github:b"]!.state).toBe("blocked");
    expect(h.cancelPlanningRun).toHaveBeenCalledWith("github:b");
    expect(h.cancelPlanningRun).toHaveBeenCalledTimes(1);
  });

  it("tolerates a per-target failure and leaves that key absent", async () => {
    const issues = candidates(2);
    const h = setup({
      results: [{ mode: "full", issues, pullRequests: [], cursor: "c1" }],
      fetchDependencies: async (iss) => {
        if (iss.id === "github:0") throw new Error("boom");
        return [{ project: "acme/widgets", key: "9" }];
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.poller.pollNow();
    warn.mockRestore();

    expect(h.fetchDependencies).toHaveBeenCalledTimes(2);
    expect(h.poller.accountsState()["github:1"]!.status).toBe("idle");
  });
});

describe("makePoller — deep hydration scoping (#328)", () => {
  const jiraAccount: Account = { provider: "jira", key: "jira:acme", id: "9", name: "acme" };

  // Issues on Jira, code on GitHub: the item's PR only ever shows up in the GitHub
  // account's poll, so that is the poll that has to hydrate it.
  function crossPlatform(): OrchestratorManifest {
    return manifest({
      items: {
        "jira:ISSUE-3": tracked("jira:ISSUE-3", "ISSUE-3", "pr-open", {
          source: "jira",
          sourceRef: { project: "PROJ", key: "ISSUE-3" },
          accountId: jiraAccount.key,
          codeHost: "github",
          pr: { id: "github:pr-7", number: 7, url: "u" },
        }),
      },
    });
  }

  it("hydrates a Jira item's PR under its code-host account, not under its tracker account", async () => {
    const h = setup({
      manifest: crossPlatform(),
      accounts: [account, jiraAccount],
      codeHostAccountFor: () => account,
      results: [{ mode: "delta", issues: [], pullRequests: [], cursor: "c1" }],
    });

    await h.poller.pollNow();

    expect(h.poll.mock.calls[0]![0]).toMatchObject({
      accountId: "github:1",
      deepHydrate: [{ owner: "acme", name: "widgets", number: 7 }],
    });
    expect(h.poll.mock.calls[1]![0]).toMatchObject({
      accountId: "jira:acme",
      deepHydrate: [],
    });
  });
});

describe("makePoller — sign-out pruning", () => {
  it("prunes account state, cache, unmapped projects and cursors in one save", async () => {
    const cursors: InboxCursorFile = {
      version: 2,
      platforms: { github: { "github:1": "c-one", "github:2": "c-two" } },
    };
    let accounts = [account, otherAccount];
    const m = manifest();
    const poll = vi.fn(async (params: { accountId: string }) => ({
      mode: "full" as const,
      issues: [issue({ id: `${params.accountId}:a`, accountId: params.accountId })],
      pullRequests: [],
      cursor: `cursor-${params.accountId}`,
    }));
    hoisted.source = { id: "github", poll } as unknown as IssueSource;
    const saveCursors = vi.fn(async () => {});
    const poller = makePoller({
      getAccounts: () => accounts,
      getToken: async () => "tok",
      codeHostAccountFor: () => undefined,
      loadCursors: async () => cursors,
      saveCursors,
      ensureManifest: async () => m,
      saveManifest: async () => {},
      ensureRepoLinks: async () => ({}),
      broadcast: () => {},
      pokeDrivers: () => {},
      cancelPlanningRun: () => {},
      sweepStaleness: () => {},
      reactToMerges: () => {},
    });

    await poller.pollNow();
    expect(Object.keys(poller.accountsState()).sort()).toEqual(["github:1", "github:2"]);

    accounts = [account];
    saveCursors.mockClear();
    await poller.pollNow();

    expect(Object.keys(poller.accountsState())).toEqual(["github:1"]);
    expect(poller.cachedFor("github:2")).toBeUndefined();
    expect(cursors.platforms.github).not.toHaveProperty("github:2");
    // One prune save, plus the per-account save that follows a successful poll.
    expect(saveCursors).toHaveBeenCalledTimes(2);
  });
});

describe("makePoller — poll failures", () => {
  it("parks the account without backoff on an auth error", async () => {
    const h = setup({ pollThrows: new AuthError("token expired") });
    await h.poller.pollNow();
    expect(h.poller.accountsState()["github:1"]).toMatchObject({
      status: "auth-error",
      error: "token expired",
    });
    expect(h.poller.accountsState()["github:1"]!.nextPollAt).toBeUndefined();
  });

  it("records a generic error for an unclassified failure", async () => {
    const h = setup({ pollThrows: new Error("socket hang up") });
    await h.poller.pollNow();
    expect(h.poller.accountsState()["github:1"]).toMatchObject({ status: "error" });
    expect(h.poller.accountsState()["github:1"]!.error).toContain("socket hang up");
  });

  it("reports polling status while a poll runs and idle after it", async () => {
    const h = setup();
    expect(h.poller.status()).toBe("idle");
    let seen: string | undefined;
    h.poll.mockImplementation(async () => {
      seen = h.poller.status();
      return { mode: "full", issues: [], pullRequests: [], cursor: "c1" };
    });
    await h.poller.pollNow();
    expect(seen).toBe("polling");
    expect(h.poller.status()).toBe("idle");
    expect(h.pokeDrivers).toHaveBeenCalledTimes(1);
    expect(h.sweepStaleness).toHaveBeenCalledTimes(1);
  });

  it("no-ops a re-entrant poll while one is already running", async () => {
    const h = setup();
    let release: () => void = () => {};
    h.poll.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ mode: "full", issues: [], pullRequests: [], cursor: "c1" });
        }),
    );
    const first = h.poller.pollNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.poll).toHaveBeenCalledTimes(1);
    await h.poller.pollNow();
    expect(h.poll).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

describe("makePoller — reconcileFromCache", () => {
  it("saves only when reconcile changed something, but always broadcasts and pokes", async () => {
    // The repo starts unfollowed, so the poll's own reconcile admits nothing and
    // the cached issue is still waiting when the follow flips.
    const m = manifest({ repoSettings: {} });
    const h = setup({
      manifest: m,
      results: [
        { mode: "full", issues: [issue({ id: "github:a" })], pullRequests: [], cursor: "c1" },
      ],
    });
    await h.poller.pollNow();

    m.repoSettings["acme/widgets"] = { followed: true };
    h.saveManifest.mockClear();
    h.broadcast.mockClear();
    h.pokeDrivers.mockClear();
    // The first pass admits the cached issue retroactively.
    await h.poller.reconcileFromCache();
    expect(h.saveManifest).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.pokeDrivers).toHaveBeenCalledTimes(1);

    h.saveManifest.mockClear();
    h.broadcast.mockClear();
    h.pokeDrivers.mockClear();
    // Nothing left to admit — no save, but the renderer is still refreshed.
    await h.poller.reconcileFromCache();
    expect(h.saveManifest).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.pokeDrivers).toHaveBeenCalledTimes(1);
  });

  it("never sweeps memory staleness (that belongs to a real poll)", async () => {
    const h = setup();
    await h.poller.reconcileFromCache();
    expect(h.sweepStaleness).not.toHaveBeenCalled();
  });
});

describe("makePoller — resetForFullWalk", () => {
  it("clears the delta cursors, persists them and forces the next walk full", async () => {
    let clock = 1_000;
    const cursors: InboxCursorFile = {
      version: 2,
      platforms: { github: { "github:1": "stored" } },
    };
    const h = setup({
      cursors,
      results: [
        { mode: "full", issues: [], pullRequests: [], cursor: "c1" },
        { mode: "delta", issues: [], pullRequests: [], cursor: "c2" },
      ],
      now: () => clock,
    });
    await h.poller.pollNow();
    clock = 2_000;

    h.saveCursors.mockClear();
    await h.poller.resetForFullWalk();
    expect(cursors.platforms).toEqual({});
    expect(h.saveCursors).toHaveBeenCalledTimes(1);

    await h.poller.pollNow();
    expect(h.poll.mock.calls[1]![0]).toMatchObject({ cursor: undefined });
  });
});

describe("makePoller — unmapped projects (#79)", () => {
  it("surfaces repo-less tracker issues and clears them once mapped", async () => {
    const repoless = issue({ id: "jira:1", repo: undefined, source: "jira" });
    repoless.sourceRef = { project: "PROJ", key: "PROJ-1" };
    const m = manifest();
    const h = setup({
      manifest: m,
      results: [{ mode: "full", issues: [repoless], pullRequests: [], cursor: "c1" }],
    });
    await h.poller.pollNow();
    expect(h.poller.unmappedProjects()).toEqual([
      expect.objectContaining({ projectKey: "PROJ", source: "jira" }),
    ]);

    m.projectMappings["jira:default:PROJ"] = "acme/widgets";
    await h.poller.reconcileFromCache();
    expect(h.poller.unmappedProjects()).toEqual([]);
  });
});
