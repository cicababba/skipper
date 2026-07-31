import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORCHESTRATOR_SETTINGS, type IssueSource, type OrchestratorManifest } from "@skipper/core";
import type { Account, Issue, RepoRef, TrackedItem } from "@skipper/shared";
import { archivePlanAndDeleteChats, discardItemWorktreeUnderLock } from "./item-teardown";
import { readStoredPlan, updateStoredPlan } from "./plan-store";
import { readStoredCoderReport } from "./report-store";
import { cancelRescore } from "./rescore";
import { cancelPlanningRun } from "./planner";
import { cancelCodingRun } from "./coder";
import { openOrPushPr } from "./shepherd";
import { fetchOrigin, forceCleanWorktree, resolveBaseRef, worktreeDirtyFiles } from "./worktrees";
import type { RepoLinksFile } from "./repo-links";
import { registerItemHandlers, type ItemIpcDeps } from "./item-ipc";

// issueSourceForAuthProvider reaches the real adapter registry (network calls),
// so closeItemOnTracker's source is the one piece of core replaced here.
const hoisted = vi.hoisted(() => ({ source: undefined as IssueSource | undefined }));

vi.mock("@skipper/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skipper/core")>();
  return { ...actual, issueSourceForAuthProvider: () => hoisted.source };
});
vi.mock("./item-teardown", () => ({
  archivePlanAndDeleteChats: vi.fn(async () => ({ ref: "archive/plan.json" })),
  discardItemWorktreeUnderLock: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("./plan-store", () => ({
  readStoredPlan: vi.fn(async () => ({ ref: "plan.json" })),
  updateStoredPlan: vi.fn(async () => ({ ref: "plan.json", revision: 2 })),
}));
vi.mock("./report-store", () => ({
  readStoredCoderReport: vi.fn(async () => ({ ref: "report.json" })),
}));
vi.mock("./rescore", () => ({ cancelRescore: vi.fn() }));
vi.mock("./planner", () => ({ cancelPlanningRun: vi.fn() }));
vi.mock("./coder", () => ({ cancelCodingRun: vi.fn() }));
vi.mock("./shepherd", () => ({ openOrPushPr: vi.fn(async () => ({ ok: true as const })) }));
vi.mock("./worktrees", () => ({
  fetchOrigin: vi.fn(async () => {}),
  forceCleanWorktree: vi.fn(async () => {}),
  resolveBaseRef: vi.fn(async () => "origin/main"),
  worktreeDirtyFiles: vi.fn(async () => [] as string[] | null),
}));

const archivePlanAndDeleteChatsMock = vi.mocked(archivePlanAndDeleteChats);
const discardItemWorktreeUnderLockMock = vi.mocked(discardItemWorktreeUnderLock);
const readStoredPlanMock = vi.mocked(readStoredPlan);
const updateStoredPlanMock = vi.mocked(updateStoredPlan);
const readStoredCoderReportMock = vi.mocked(readStoredCoderReport);
const cancelRescoreMock = vi.mocked(cancelRescore);
const cancelPlanningRunMock = vi.mocked(cancelPlanningRun);
const cancelCodingRunMock = vi.mocked(cancelCodingRun);
const openOrPushPrMock = vi.mocked(openOrPushPr);
const forceCleanWorktreeMock = vi.mocked(forceCleanWorktree);
const worktreeDirtyFilesMock = vi.mocked(worktreeDirtyFiles);
const fetchOriginMock = vi.mocked(fetchOrigin);
const resolveBaseRefMock = vi.mocked(resolveBaseRef);

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const account: Account = { provider: "github", key: "github:1", id: "1", name: "cicababba" };

const VALID_PLAN = {
  summary: "do the thing",
  context: ["the file drifted"],
  files: [{ path: "src/a.ts", reason: "the edit lands here" }],
  steps: [{ title: "step one", detail: "edit the file", files: ["src/a.ts"], symbols: [] }],
  outOfScope: [],
  acceptance: [{ criterion: "it builds", addressedBy: "step one" }],
  risks: [],
  verificationCommands: ["pnpm build"],
  manualChecks: [],
  openQuestions: [],
  estimatedSize: "s",
};

function trackedItem(overrides: Partial<TrackedItem> & { id: string }): TrackedItem {
  return {
    source: "github",
    sourceRef: { project: "acme/widgets", key: "1" },
    codeHost: "github",
    accountId: account.key,
    repo: { owner: "acme", name: "widgets" },
    key: "1",
    number: 1,
    title: "an issue",
    url: "https://github.com/acme/widgets/issues/1",
    state: "plan-gate",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    transitions: [],
    ...overrides,
  } as TrackedItem;
}

function manifest(overrides: Partial<OrchestratorManifest> = {}): OrchestratorManifest {
  return {
    version: 3,
    settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS },
    items: {},
    parked: {},
    repoSettings: {},
    projectMappings: {},
    ...overrides,
  };
}

const linked: RepoLinksFile = {
  version: 1,
  repos: { "acme/widgets": { localPath: "/repo", linkedAt: "t", baseBranch: "main" } },
};

interface SetupOptions {
  manifest?: OrchestratorManifest;
  links?: RepoLinksFile;
  cached?: Issue;
  closeIssue?: () => Promise<void>;
  noSource?: boolean;
  accounts?: Account[];
  transitionThrows?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const m = opts.manifest ?? manifest();
  const closeIssue = vi.fn(async () => {
    if (opts.closeIssue) await opts.closeIssue();
  });
  hoisted.source = opts.noSource ? undefined : ({ id: "github", closeIssue } as unknown as IssueSource);

  const saveManifest = vi.fn(async () => {});
  const broadcast = vi.fn();
  const pokePlanner = vi.fn();
  const pokeCoder = vi.fn();
  const reconcileFromCache = vi.fn(async () => {});
  const dropCached = vi.fn();
  const markCachedIssueClosed = vi.fn();
  const snapshot = vi.fn(() => ({ marker: "state" }) as never);
  const requestTransition = vi.fn(async (itemId: string) => {
    if (opts.transitionThrows) throw new Error("illegal transition triage → coding");
    return trackedItem({ id: itemId, state: "planning" });
  });
  const withRepoGitLock = vi.fn(<T>(_repo: RepoRef, fn: () => Promise<T>): Promise<T> => fn());
  const deps = {
    ipcMain,
    plansDir: "/data/plans",
    ensureManifest: async () => m,
    saveManifest,
    ensureRepoLinks: async () => opts.links ?? { version: 1, repos: {} },
    snapshot,
    broadcast,
    requestTransition,
    pokePlanner,
    pokeCoder,
    reconcileFromCache,
    withRepoGitLock,
    getAccounts: () => opts.accounts ?? [account],
    getToken: async () => "tok",
    codeHostAccountFor: () => account,
    getCached: () => opts.cached,
    dropCached,
    markCachedIssueClosed,
  } as unknown as ItemIpcDeps;
  registerItemHandlers(deps);
  return {
    handlers,
    m,
    saveManifest,
    broadcast,
    pokePlanner,
    pokeCoder,
    reconcileFromCache,
    dropCached,
    markCachedIssueClosed,
    snapshot,
    requestTransition,
    withRepoGitLock,
    closeIssue,
  };
}

function handlerOf(handlers: Map<string, Handler>, channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  archivePlanAndDeleteChatsMock.mockResolvedValue({ ref: "archive/plan.json" } as never);
  discardItemWorktreeUnderLockMock.mockResolvedValue({ ok: true } as never);
  readStoredPlanMock.mockResolvedValue({ ref: "plan.json" } as never);
  updateStoredPlanMock.mockResolvedValue({ ref: "plan.json", revision: 2 } as never);
  readStoredCoderReportMock.mockResolvedValue({ ref: "report.json" } as never);
  openOrPushPrMock.mockResolvedValue({ ok: true } as never);
  worktreeDirtyFilesMock.mockResolvedValue([]);
  fetchOriginMock.mockResolvedValue(undefined as never);
  resolveBaseRefMock.mockResolvedValue("origin/main");
});

describe("registerItemHandlers", () => {
  it("registers every item channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      "skipper:orchestrator:archiveItem",
      "skipper:orchestrator:cleanWorktree",
      "skipper:orchestrator:closeItemOnTracker",
      "skipper:orchestrator:getCoderReport",
      "skipper:orchestrator:getPlan",
      "skipper:orchestrator:openPr",
      "skipper:orchestrator:requestTransition",
      "skipper:orchestrator:resolveResumeRite",
      "skipper:orchestrator:setPinned",
      "skipper:orchestrator:untrackItem",
      "skipper:orchestrator:updatePlan",
    ]);
  });

  it("wraps an illegal transition into an error result", async () => {
    const h = setup({ transitionThrows: true });
    const res = await handlerOf(h.handlers, "skipper:orchestrator:requestTransition")(
      null,
      "github:1",
      "coding",
    );
    expect(res).toEqual({ ok: false, error: "illegal transition triage → coding" });
  });
});

describe("getPlan / getCoderReport", () => {
  it("returns null when the item carries no ref", async () => {
    const h = setup({ manifest: manifest({ items: { "github:1": trackedItem({ id: "github:1" }) } }) });
    expect(await handlerOf(h.handlers, "skipper:orchestrator:getPlan")(null, "github:1")).toBeNull();
    expect(readStoredPlanMock).not.toHaveBeenCalled();
    expect(
      await handlerOf(h.handlers, "skipper:orchestrator:getCoderReport")(null, "github:1"),
    ).toBeNull();
  });

  it("reads through the stores when a ref exists", async () => {
    const item = trackedItem({
      id: "github:1",
      plan: { ref: "plan.json" },
      coderReport: { ref: "report.json" },
    } as Partial<TrackedItem> & { id: string });
    const h = setup({ manifest: manifest({ items: { "github:1": item } }) });
    await handlerOf(h.handlers, "skipper:orchestrator:getPlan")(null, "github:1");
    expect(readStoredPlanMock).toHaveBeenCalledWith("/data/plans", "plan.json");
    await handlerOf(h.handlers, "skipper:orchestrator:getCoderReport")(null, "github:1");
    expect(readStoredCoderReportMock).toHaveBeenCalledWith("/data/plans", "report.json");
  });
});

describe("updatePlan (#13)", () => {
  const CHANNEL = "skipper:orchestrator:updatePlan";
  const gated = (state: TrackedItem["state"]): OrchestratorManifest =>
    manifest({
      items: {
        "github:1": trackedItem({
          id: "github:1",
          state,
          plan: { ref: "plan.json" },
        } as Partial<TrackedItem> & { id: string }),
      },
    });

  it("refuses an unknown item", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:404", VALID_PLAN);
    expect(res).toEqual({ ok: false, error: "unknown item github:404" });
  });

  it("refuses outside plan-gate", async () => {
    const h = setup({ manifest: gated("planning") });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1", VALID_PLAN);
    expect(res).toEqual({
      ok: false,
      error: "plan is only editable in plan-gate (item is planning)",
    });
    expect(updateStoredPlanMock).not.toHaveBeenCalled();
  });

  it("refuses when the item has no stored plan", async () => {
    const h = setup({
      manifest: manifest({ items: { "github:1": trackedItem({ id: "github:1" }) } }),
    });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1", VALID_PLAN);
    expect(res).toEqual({ ok: false, error: "item has no stored plan" });
  });

  it("refuses a plan that fails schema validation", async () => {
    const h = setup({ manifest: gated("plan-gate") });
    const res = (await handlerOf(h.handlers, CHANNEL)(null, "github:1", { steps: "nope" })) as {
      ok: false;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^invalid plan: /);
    expect(updateStoredPlanMock).not.toHaveBeenCalled();
    expect(cancelRescoreMock).not.toHaveBeenCalled();
  });

  it("refuses when the stored plan vanished", async () => {
    updateStoredPlanMock.mockResolvedValue(null as never);
    const h = setup({ manifest: gated("plan-gate") });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1", VALID_PLAN);
    expect(res).toEqual({ ok: false, error: "stored plan not found" });
    expect(cancelRescoreMock).not.toHaveBeenCalled();
  });

  it("persists the edit and cancels an in-flight rescore (#164)", async () => {
    const h = setup({ manifest: gated("plan-gate") });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1", VALID_PLAN);
    expect(res).toEqual({ ok: true, stored: { ref: "plan.json", revision: 2 } });
    expect(updateStoredPlanMock).toHaveBeenCalledWith(
      "/data/plans",
      "plan.json",
      expect.objectContaining({ summary: "do the thing" }),
      "inline-edit",
    );
    expect(cancelRescoreMock).toHaveBeenCalledWith("github:1");
  });
});

describe("setPinned", () => {
  it("clears the flag rather than storing false", async () => {
    const m = manifest({ items: { "github:1": trackedItem({ id: "github:1", pinned: true }) } });
    const h = setup({ manifest: m });
    await handlerOf(h.handlers, "skipper:orchestrator:setPinned")(null, "github:1", false);
    expect(h.m.items["github:1"]!.pinned).toBeUndefined();
    expect(h.pokeCoder).toHaveBeenCalledTimes(1);
  });
});

describe("archiveItem (#115)", () => {
  const CHANNEL = "skipper:orchestrator:archiveItem";

  it("refuses an item that is not closed", async () => {
    const h = setup({
      manifest: manifest({ items: { "github:1": trackedItem({ id: "github:1" }) } }),
    });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "only closed items can be archived" });
  });

  it("asks for confirmation when the worktree is dirty", async () => {
    worktreeDirtyFilesMock.mockResolvedValue(["src/a.ts", "src/b.ts"]);
    const h = setup({
      links: linked,
      manifest: manifest({
        items: {
          "github:1": trackedItem({
            id: "github:1",
            state: "closed",
            worktree: { path: "/wt/1", branch: "feature/issue-1" },
          }),
        },
      }),
    });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, needsConfirm: true, dirtyFiles: 2 });
    expect(discardItemWorktreeUnderLockMock).not.toHaveBeenCalled();
  });

  it("forces through a dirty worktree and archives the plan", async () => {
    worktreeDirtyFilesMock.mockResolvedValue(["src/a.ts"]);
    const h = setup({
      links: linked,
      manifest: manifest({
        items: {
          "github:1": trackedItem({
            id: "github:1",
            state: "closed",
            worktree: { path: "/wt/1", branch: "feature/issue-1" },
          }),
        },
      }),
    });
    const res = (await handlerOf(h.handlers, CHANNEL)(null, "github:1", true)) as {
      ok: true;
      item: TrackedItem;
    };
    expect(res.ok).toBe(true);
    expect(res.item.worktree).toBeUndefined();
    expect(res.item.plan).toEqual({ ref: "archive/plan.json" });
    expect(discardItemWorktreeUnderLockMock).toHaveBeenCalledTimes(1);
    expect(h.saveManifest).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed discard", async () => {
    discardItemWorktreeUnderLockMock.mockResolvedValue({
      ok: false,
      error: "worktree busy",
    } as never);
    const h = setup({
      links: linked,
      manifest: manifest({
        items: {
          "github:1": trackedItem({
            id: "github:1",
            state: "closed",
            worktree: { path: "/wt/1", branch: "feature/issue-1" },
          }),
        },
      }),
    });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "worktree busy" });
    expect(h.saveManifest).not.toHaveBeenCalled();
  });
});

describe("untrackItem (#120)", () => {
  const CHANNEL = "skipper:orchestrator:untrackItem";

  it("asks for confirmation when a worktree or PR exists", async () => {
    worktreeDirtyFilesMock.mockResolvedValue(["src/a.ts"]);
    const h = setup({
      links: linked,
      manifest: manifest({
        items: {
          "github:1": trackedItem({
            id: "github:1",
            worktree: { path: "/wt/1", branch: "feature/issue-1" },
            pr: { number: 7, url: "https://github.com/acme/widgets/pull/7" },
          } as Partial<TrackedItem> & { id: string }),
        },
      }),
    });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({
      ok: false,
      needsConfirm: true,
      hasWorktree: true,
      dirtyFiles: 1,
      hasPr: true,
    });
    expect(h.dropCached).not.toHaveBeenCalled();
  });

  it("cancels the active run, drops the cache entry and prunes the rite", async () => {
    const m = manifest({
      items: { "github:1": trackedItem({ id: "github:1", state: "coding" }) },
      parked: { "github:1": { firstSeenAt: "t" } },
      resumeRite: { itemIds: ["github:1"], createdAt: "t" },
    });
    const h = setup({ manifest: m });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: true });
    expect(cancelCodingRunMock).toHaveBeenCalledWith("github:1");
    expect(cancelPlanningRunMock).not.toHaveBeenCalled();
    expect(cancelRescoreMock).toHaveBeenCalledWith("github:1");
    expect(h.m.items).toEqual({});
    expect(h.m.parked).toEqual({});
    expect(h.m.resumeRite).toBeUndefined();
    expect(h.dropCached).toHaveBeenCalledWith("github:1", "github:1");
  });

  it("keeps a resume rite that still has other items", async () => {
    const m = manifest({
      items: { "github:1": trackedItem({ id: "github:1", state: "planning" }) },
      resumeRite: { itemIds: ["github:1", "github:2"], createdAt: "t" },
    });
    const h = setup({ manifest: m });
    await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(cancelPlanningRunMock).toHaveBeenCalledWith("github:1");
    expect(h.m.resumeRite).toEqual({ itemIds: ["github:2"], createdAt: "t" });
  });
});

describe("cleanWorktree (#204)", () => {
  const CHANNEL = "skipper:orchestrator:cleanWorktree";
  const withWorktree = (state: TrackedItem["state"]): OrchestratorManifest =>
    manifest({
      items: {
        "github:1": trackedItem({
          id: "github:1",
          state,
          worktree: { path: "/wt/1", branch: "feature/issue-1" },
        }),
      },
    });

  it("refuses when no worktree is recorded", async () => {
    const h = setup({
      links: linked,
      manifest: manifest({ items: { "github:1": trackedItem({ id: "github:1" }) } }),
    });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "no worktree recorded for item" });
  });

  it("refuses while a run holds the worktree", async () => {
    const h = setup({ links: linked, manifest: withWorktree("coding") });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "a run is active in this worktree" });
    expect(h.withRepoGitLock).not.toHaveBeenCalled();
  });

  it("refuses when the repo is not linked", async () => {
    const h = setup({ manifest: withWorktree("plan-gate") });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "repo acme/widgets is not linked" });
  });

  it("refuses when the worktree folder is gone", async () => {
    worktreeDirtyFilesMock.mockResolvedValue(null);
    const h = setup({ links: linked, manifest: withWorktree("plan-gate") });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "worktree folder is missing on disk" });
    expect(forceCleanWorktreeMock).not.toHaveBeenCalled();
  });

  it("resets the worktree to the base ref under the repo lock", async () => {
    const h = setup({ links: linked, manifest: withWorktree("plan-gate") });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: true });
    expect(h.withRepoGitLock).toHaveBeenCalledTimes(1);
    expect(forceCleanWorktreeMock).toHaveBeenCalledWith("/wt/1", "origin/main");
  });

  it("returns the error when resolving the base ref throws", async () => {
    resolveBaseRefMock.mockRejectedValue(new Error("no origin/main"));
    const h = setup({ links: linked, manifest: withWorktree("plan-gate") });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "no origin/main" });
  });
});

describe("closeItemOnTracker (#132)", () => {
  const CHANNEL = "skipper:orchestrator:closeItemOnTracker";
  const tracked = manifest({ items: { "github:1": trackedItem({ id: "github:1" }) } });

  it("refuses when the source has no closeIssue capability", async () => {
    const h = setup({ manifest: tracked, noSource: true });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({
      ok: false,
      error: "closing on the tracker is not supported for github",
    });
  });

  it("returns the adapter error and leaves the cache alone", async () => {
    const h = setup({
      manifest: tracked,
      closeIssue: async () => {
        throw new Error("Resource not accessible by integration");
      },
    });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "Resource not accessible by integration" });
    expect(h.markCachedIssueClosed).not.toHaveBeenCalled();
    expect(h.reconcileFromCache).not.toHaveBeenCalled();
  });

  it("synthesizes the issue when the poll cache lacks it", async () => {
    const h = setup({ manifest: tracked });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: true });
    const [issue] = h.closeIssue.mock.calls[0] as unknown as [Issue];
    expect(issue).toMatchObject({
      kind: "issue",
      id: "github:1",
      state: "open",
      labels: [],
      assignees: [],
    });
    // Nothing cached → nothing to flip, but the manifest still settles.
    expect(h.markCachedIssueClosed).not.toHaveBeenCalled();
    expect(h.reconcileFromCache).toHaveBeenCalledTimes(1);
  });

  it("uses the cached issue and flips it closed", async () => {
    const cached = { kind: "issue", id: "github:1", state: "open" } as unknown as Issue;
    const h = setup({ manifest: tracked, cached });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: true });
    expect((h.closeIssue.mock.calls[0] as unknown as [Issue])[0]).toBe(cached);
    expect(h.markCachedIssueClosed).toHaveBeenCalledWith("github:1", "github:1");
    expect(h.reconcileFromCache).toHaveBeenCalledTimes(1);
  });
});

describe("resolveResumeRite (#15)", () => {
  const CHANNEL = "skipper:orchestrator:resolveResumeRite";
  const rite = (): OrchestratorManifest =>
    manifest({
      items: {
        "github:1": trackedItem({ id: "github:1", state: "triage", holdAutoPlan: true } as Partial<TrackedItem> & { id: string }),
        "github:2": trackedItem({ id: "github:2", state: "triage", holdAutoPlan: true } as Partial<TrackedItem> & { id: string }),
      },
      resumeRite: { itemIds: ["github:1", "github:2"], createdAt: "t" },
    });

  it("plans everything on plan-all and clears the rite", async () => {
    const h = setup({ manifest: rite() });
    await handlerOf(h.handlers, CHANNEL)(null, "plan-all");
    expect(h.m.items["github:1"]!.state).toBe("planning");
    expect(h.m.items["github:2"]!.state).toBe("planning");
    expect(h.m.items["github:1"]!.holdAutoPlan).toBeUndefined();
    expect(h.m.resumeRite).toBeUndefined();
    expect(h.pokePlanner).toHaveBeenCalledTimes(1);
  });

  it("plans only the selected ids that are actually in the rite", async () => {
    const h = setup({ manifest: rite() });
    await handlerOf(h.handlers, CHANNEL)(null, "plan-selected", ["github:2", "github:99"]);
    expect(h.m.items["github:1"]!.state).toBe("triage");
    expect(h.m.items["github:2"]!.state).toBe("planning");
    expect(h.m.resumeRite).toBeUndefined();
  });

  it("dismiss clears the rite without planning anything", async () => {
    const h = setup({ manifest: rite() });
    await handlerOf(h.handlers, CHANNEL)(null, "dismiss");
    expect(h.m.items["github:1"]!.state).toBe("triage");
    expect(h.m.resumeRite).toBeUndefined();
    expect(h.saveManifest).toHaveBeenCalledTimes(1);
  });

  it("no-ops when there is no rite", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "plan-all");
    expect(res).toEqual({ marker: "state" });
    expect(h.saveManifest).not.toHaveBeenCalled();
  });
});

describe("openPr", () => {
  it("hydrates the manifest and links before delegating to the shepherd", async () => {
    const h = setup({ links: linked });
    const res = await handlerOf(h.handlers, "skipper:orchestrator:openPr")(null, "github:1");
    expect(res).toEqual({ ok: true });
    expect(openOrPushPrMock).toHaveBeenCalledWith("github:1", "user");
  });
});
