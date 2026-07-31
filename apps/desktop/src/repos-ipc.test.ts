import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORCHESTRATOR_SETTINGS, type OrchestratorManifest } from "@skipper/core";
import type { Account, RepoRef, TrackedItem } from "@skipper/shared";
import { runGit } from "./git";
import { discardWorktree, fetchOrigin, resolveBaseRef, worktreeDirtyFiles } from "./worktrees";
import {
  branchesForLocalClone,
  cloneRepo,
  detectHostForLocalPath,
  listRemoteHeads,
  type RepoLinksFile,
} from "./repo-links";
import { registerReposHandlers, type ReposIpcDeps } from "./repos-ipc";

vi.mock("./git", () => ({ runGit: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) }));
vi.mock("./worktrees", () => ({
  discardWorktree: vi.fn(async () => ({ removed: true, branchDeleted: true })),
  fetchOrigin: vi.fn(async () => {}),
  resolveBaseRef: vi.fn(async () => "origin/main"),
  worktreeDirtyFiles: vi.fn(async () => [] as string[]),
}));
vi.mock("./repo-links", () => ({
  branchesForLocalClone: vi.fn(async () => ({ ok: true, branches: ["main"], defaultBranch: "main" })),
  cloneRepo: vi.fn(async () => "/clones/widgets"),
  detectHostForLocalPath: vi.fn(async () => "github"),
  listRemoteHeads: vi.fn(async () => ({ branches: ["main", "develop"], defaultBranch: "main" })),
}));

const runGitMock = vi.mocked(runGit);
const fetchOriginMock = vi.mocked(fetchOrigin);
const resolveBaseRefMock = vi.mocked(resolveBaseRef);
const discardWorktreeMock = vi.mocked(discardWorktree);
const worktreeDirtyFilesMock = vi.mocked(worktreeDirtyFiles);
const branchesForLocalCloneMock = vi.mocked(branchesForLocalClone);
const cloneRepoMock = vi.mocked(cloneRepo);
const detectHostForLocalPathMock = vi.mocked(detectHostForLocalPath);
const listRemoteHeadsMock = vi.mocked(listRemoteHeads);

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const account: Account = { provider: "github", key: "github:1", id: "1", name: "cicababba" };

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

interface SetupOptions {
  manifest?: OrchestratorManifest;
  links?: RepoLinksFile;
  accounts?: Account[];
  token?: string | null;
  cachedRepos?: RepoRef[];
  defaultModel?: string;
  accountForRepo?: Account | undefined;
  transitionThrows?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const m = opts.manifest ?? manifest();
  const links = opts.links ?? { version: 1 as const, repos: {} };
  const saveManifest = vi.fn(async () => {});
  const saveLinks = vi.fn(async () => {});
  const broadcast = vi.fn();
  const reconcileFromCache = vi.fn(async () => {});
  const pokePlanner = vi.fn();
  const pokeCoder = vi.fn();
  const seedInstructions = vi.fn(async (_repo: RepoRef, _localPath: string, _force?: boolean) => {});
  const kickGraphify = vi.fn();
  const snapshot = vi.fn(() => ({ marker: "state" }) as never);
  const requestTransition = vi.fn(async (itemId: string) => {
    if (opts.transitionThrows) throw new Error("illegal transition");
    return trackedItem({ id: itemId, state: "planning" });
  });
  const order: string[] = [];
  const withRepoGitLock = vi.fn(async <T>(_repo: RepoRef, fn: () => Promise<T>): Promise<T> => {
    order.push("lock-enter");
    const result = await fn();
    order.push("lock-exit");
    return result;
  });
  const deps = {
    ipcMain,
    ensureManifest: async () => m,
    saveManifest,
    ensureRepoLinks: async () => links,
    saveLinks,
    getAccounts: () => opts.accounts ?? [account],
    getToken: async () => ("token" in opts ? opts.token : "tok-abc") ?? null,
    snapshot,
    broadcast,
    reconcileFromCache,
    pokePlanner,
    pokeCoder,
    withRepoGitLock,
    requestTransition: vi.fn(async (itemId: string, to, actor, reason) => {
      order.push(`transition:${itemId}`);
      void to;
      void actor;
      void reason;
      return requestTransition(itemId);
    }),
    seedInstructions: vi.fn(async (repo: RepoRef, localPath: string, force?: boolean) => {
      order.push("seed");
      return seedInstructions(repo, localPath, force);
    }),
    kickGraphify,
    accountForRepo: () => ("accountForRepo" in opts ? opts.accountForRepo : account),
    cachedRepos: () => opts.cachedRepos ?? [],
    getDefaultModel: () => opts.defaultModel,
  } as unknown as ReposIpcDeps;
  registerReposHandlers(deps);
  const wrappedReconcile = reconcileFromCache;
  reconcileFromCache.mockImplementation(async () => {
    order.push("reconcile");
  });
  return {
    handlers,
    m,
    links,
    saveManifest,
    saveLinks,
    broadcast,
    reconcileFromCache: wrappedReconcile,
    pokePlanner,
    pokeCoder,
    seedInstructions,
    kickGraphify,
    snapshot,
    requestTransition,
    withRepoGitLock,
    order,
  };
}

function handlerOf(handlers: Map<string, Handler>, channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  runGitMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  fetchOriginMock.mockResolvedValue(undefined as never);
  resolveBaseRefMock.mockResolvedValue("origin/main");
  discardWorktreeMock.mockResolvedValue({ removed: true, branchDeleted: true });
  worktreeDirtyFilesMock.mockResolvedValue([]);
  branchesForLocalCloneMock.mockResolvedValue({
    ok: true,
    branches: ["main"],
    defaultBranch: "main",
  });
  cloneRepoMock.mockResolvedValue("/clones/widgets");
  detectHostForLocalPathMock.mockResolvedValue("github" as never);
  listRemoteHeadsMock.mockResolvedValue({ branches: ["main", "develop"], defaultBranch: "main" });
});

describe("registerReposHandlers", () => {
  it("registers every repo channel exactly once", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        "skipper:orchestrator:cloneRepo",
        "skipper:orchestrator:inspectLinkTarget",
        "skipper:orchestrator:linkRepo",
        "skipper:orchestrator:listRemoteBranches",
        "skipper:orchestrator:listRepoBranches",
        "skipper:orchestrator:listRepoSettings",
        "skipper:orchestrator:listRepos",
        "skipper:orchestrator:setRepoBaseBranch",
        "skipper:orchestrator:setRepoSettings",
        "skipper:orchestrator:unlinkRepo",
      ].sort(),
    );
  });
});

describe("linkRepo", () => {
  const CHANNEL = "skipper:orchestrator:linkRepo";

  it("fetches once when the base branch is missing, then refuses if it stays missing", async () => {
    const h = setup();
    runGitMock.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "/repo", "release");
    expect(res).toEqual({ ok: false, error: "branch 'release' not found on origin" });
    expect(fetchOriginMock).toHaveBeenCalledTimes(1);
    expect(runGitMock).toHaveBeenCalledTimes(2);
    expect(h.saveLinks).not.toHaveBeenCalled();
  });

  it("accepts a base branch that appears only after the fetch", async () => {
    const h = setup();
    runGitMock
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "/repo", " release ");
    expect(res).toEqual({ ok: true, localPath: "/repo" });
    expect(h.links.repos["acme/widgets"]).toMatchObject({
      localPath: "/repo",
      baseBranch: "release",
    });
  });

  it("persists the link, follows the repo, then seeds before reconciling", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "/repo");
    expect(res).toEqual({ ok: true, localPath: "/repo" });
    expect(h.links.repos["acme/widgets"]).toMatchObject({ localPath: "/repo" });
    expect(h.links.repos["acme/widgets"]).not.toHaveProperty("baseBranch");
    expect(h.m.repoSettings["acme/widgets"]).toEqual({ followed: true });
    expect(h.saveLinks).toHaveBeenCalledTimes(1);
    expect(h.saveManifest).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["seed", "reconcile"]);
  });

  it("does not consult git when no base branch is given", async () => {
    const h = setup();
    await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "/repo");
    expect(runGitMock).not.toHaveBeenCalled();
  });

  it("returns the detect error when the local path is not the right repo", async () => {
    const h = setup();
    detectHostForLocalPathMock.mockRejectedValue(new Error("origin points elsewhere"));
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "/repo");
    expect(res).toEqual({ ok: false, error: "origin points elsewhere" });
  });
});

describe("cloneRepo", () => {
  const CHANNEL = "skipper:orchestrator:cloneRepo";

  it("refuses when no account token is available", async () => {
    const h = setup({ token: null });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "/clones");
    expect(res).toEqual({ ok: false, error: "no account token available for this repo" });
    expect(cloneRepoMock).not.toHaveBeenCalled();
  });

  it("clones, links and follows the repo", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "/clones");
    expect(res).toEqual({ ok: true, localPath: "/clones/widgets" });
    expect(h.links.repos["acme/widgets"]).toMatchObject({ localPath: "/clones/widgets" });
    expect(h.m.repoSettings["acme/widgets"]).toEqual({ followed: true });
    expect(h.order).toEqual(["seed", "reconcile"]);
  });

  it("never fetches for the base-branch check — a fresh clone carries every head", async () => {
    const h = setup();
    runGitMock.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const res = await handlerOf(h.handlers, CHANNEL)(
      null,
      "acme",
      "widgets",
      "/clones",
      undefined,
      "release",
    );
    expect(res).toEqual({ ok: false, error: "branch 'release' not found on origin" });
    expect(fetchOriginMock).not.toHaveBeenCalled();
    expect(h.saveLinks).not.toHaveBeenCalled();
  });
});

describe("unlinkRepo", () => {
  it("drops the link and keeps the instructions doc untouched", async () => {
    const h = setup({
      links: { version: 1, repos: { "acme/widgets": { localPath: "/repo", linkedAt: "t" } } },
    });
    const res = await handlerOf(h.handlers, "skipper:orchestrator:unlinkRepo")(
      null,
      "acme",
      "widgets",
    );
    expect(res).toEqual({ ok: true });
    expect(h.links.repos).toEqual({});
    expect(h.saveLinks).toHaveBeenCalledTimes(1);
    // No instructions dep exists on this module — nothing can delete the doc.
    expect(h.seedInstructions).not.toHaveBeenCalled();
  });
});

describe("setRepoBaseBranch", () => {
  const CHANNEL = "skipper:orchestrator:setRepoBaseBranch";
  const linkedRepo = (): RepoLinksFile => ({
    version: 1,
    repos: { "acme/widgets": { localPath: "/repo", linkedAt: "t", baseBranch: "main" } },
  });

  it("refuses when the repo is not linked", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "develop");
    expect(res).toEqual({ ok: false, error: "repo not linked" });
  });

  it("refuses a branch that is not on origin", async () => {
    const h = setup({ links: linkedRepo() });
    runGitMock.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "develop");
    expect(res).toEqual({ ok: false, error: "branch 'develop' not found on origin" });
    expect(h.saveLinks).not.toHaveBeenCalled();
  });

  it("persists but short-circuits when the resolved base ref does not change", async () => {
    const links = linkedRepo();
    const h = setup({ links });
    resolveBaseRefMock.mockResolvedValue("origin/main");
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "develop");
    expect(res).toEqual({ ok: true });
    expect(links.repos["acme/widgets"]!.baseBranch).toBe("develop");
    expect(h.saveLinks).toHaveBeenCalledTimes(1);
    expect(h.withRepoGitLock).not.toHaveBeenCalled();
  });

  it("clears the override when the new base is blank", async () => {
    const links = linkedRepo();
    const h = setup({ links });
    await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "   ");
    expect(links.repos["acme/widgets"]).not.toHaveProperty("baseBranch");
    expect(runGitMock).not.toHaveBeenCalled();
  });

  it("discards clean worktrees under one lock and replans afterwards", async () => {
    const item = trackedItem({
      id: "github:1",
      state: "plan-gate",
      worktree: { path: "/wt/1", branch: "feature/issue-1" },
    });
    const m = manifest({ items: { "github:1": item } });
    const h = setup({ links: linkedRepo(), manifest: m });
    runGitMock.mockResolvedValue({ code: 0, stdout: "0\n", stderr: "" });
    resolveBaseRefMock
      .mockResolvedValueOnce("origin/main")
      .mockResolvedValueOnce("origin/develop")
      .mockResolvedValue("origin/main");

    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "develop");

    expect(res).toEqual({ ok: true, replan: { replanned: ["github:1"], skipped: [] } });
    expect(discardWorktreeMock).toHaveBeenCalledTimes(1);
    // The transition must happen after the lock released, never nested inside it.
    expect(h.order).toEqual(["lock-enter", "lock-exit", "transition:github:1"]);
    expect(h.m.items["github:1"]!.worktree).toBeUndefined();
    expect(h.saveManifest).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it("turns an illegal transition into a skipped entry", async () => {
    const item = trackedItem({
      id: "github:1",
      state: "plan-gate",
      worktree: { path: "/wt/1", branch: "feature/issue-1" },
    });
    const m = manifest({ items: { "github:1": item } });
    const h = setup({ links: linkedRepo(), manifest: m, transitionThrows: true });
    runGitMock.mockResolvedValue({ code: 0, stdout: "0\n", stderr: "" });
    resolveBaseRefMock
      .mockResolvedValueOnce("origin/main")
      .mockResolvedValueOnce("origin/develop")
      .mockResolvedValue("origin/main");

    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "develop");

    expect(res).toEqual({
      ok: true,
      replan: {
        replanned: [],
        skipped: [{ id: "github:1", key: "1", reason: "illegal-transition" }],
      },
    });
  });

  it("skips a worktree that carries its own commits", async () => {
    const item = trackedItem({
      id: "github:1",
      state: "plan-gate",
      worktree: { path: "/wt/1", branch: "feature/issue-1" },
    });
    const m = manifest({ items: { "github:1": item } });
    const h = setup({ links: linkedRepo(), manifest: m });
    runGitMock.mockResolvedValue({ code: 0, stdout: "3\n", stderr: "" });
    resolveBaseRefMock
      .mockResolvedValueOnce("origin/main")
      .mockResolvedValueOnce("origin/develop")
      .mockResolvedValue("origin/main");

    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "develop");

    expect(res).toEqual({
      ok: true,
      replan: { replanned: [], skipped: [{ id: "github:1", key: "1", reason: "own-commits" }] },
    });
    expect(discardWorktreeMock).not.toHaveBeenCalled();
    expect(h.m.items["github:1"]!.worktree).toEqual({ path: "/wt/1", branch: "feature/issue-1" });
  });

  it("skips a dirty worktree", async () => {
    const item = trackedItem({
      id: "github:1",
      state: "plan-gate",
      worktree: { path: "/wt/1", branch: "feature/issue-1" },
    });
    const m = manifest({ items: { "github:1": item } });
    const h = setup({ links: linkedRepo(), manifest: m });
    worktreeDirtyFilesMock.mockResolvedValue(["src/a.ts"]);
    resolveBaseRefMock
      .mockResolvedValueOnce("origin/main")
      .mockResolvedValueOnce("origin/develop")
      .mockResolvedValue("origin/main");

    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "develop");

    expect(res).toEqual({
      ok: true,
      replan: { replanned: [], skipped: [{ id: "github:1", key: "1", reason: "dirty" }] },
    });
    expect(discardWorktreeMock).not.toHaveBeenCalled();
    expect(h.saveManifest).not.toHaveBeenCalled();
  });

  it("treats an unresolvable base ref as a change", async () => {
    const m = manifest({ items: {} });
    const h = setup({ links: linkedRepo(), manifest: m });
    resolveBaseRefMock.mockRejectedValue(new Error("no such ref"));
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "develop");
    expect(res).toEqual({ ok: true, replan: { replanned: [], skipped: [] } });
    expect(h.withRepoGitLock).toHaveBeenCalledTimes(1);
  });
});

describe("setRepoSettings", () => {
  const CHANNEL = "skipper:orchestrator:setRepoSettings";

  it("keeps a repo with active items followed despite an unfollow patch", async () => {
    const m = manifest({
      items: { "github:1": trackedItem({ id: "github:1", state: "coding" }) },
      repoSettings: { "acme/widgets": { followed: true } },
    });
    const h = setup({ manifest: m });
    await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", { followed: false });
    expect(h.m.repoSettings["acme/widgets"]).toEqual({ followed: true });
  });

  it("deletes the key when the merged patch is empty", async () => {
    const m = manifest({ repoSettings: { "acme/widgets": { priority: "low" } } });
    const h = setup({ manifest: m });
    await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", { priority: undefined });
    expect(h.m.repoSettings).not.toHaveProperty("acme/widgets");
    expect(h.saveManifest).toHaveBeenCalledTimes(1);
  });

  it("kicks a first Graphify index when the flag flips on", async () => {
    const m = manifest({ repoSettings: { "acme/widgets": { followed: true } } });
    const h = setup({ manifest: m });
    await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", { graphify: true });
    expect(h.kickGraphify).toHaveBeenCalledWith({ owner: "acme", name: "widgets" });
  });

  it("does not re-kick Graphify when it was already on", async () => {
    const m = manifest({ repoSettings: { "acme/widgets": { followed: true, graphify: true } } });
    const h = setup({ manifest: m });
    await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", { priority: "low" });
    expect(h.kickGraphify).not.toHaveBeenCalled();
  });

  it("reconciles instead of broadcasting when the repo becomes followed", async () => {
    const h = setup();
    await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", { followed: true });
    expect(h.reconcileFromCache).toHaveBeenCalledTimes(1);
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.pokePlanner).not.toHaveBeenCalled();
  });

  it("broadcasts and pokes when the follow flag did not flip on", async () => {
    const m = manifest({ repoSettings: { "acme/widgets": { followed: true } } });
    const h = setup({ manifest: m });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", { priority: "high" });
    expect(h.reconcileFromCache).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.pokePlanner).toHaveBeenCalledTimes(1);
    expect(h.pokeCoder).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ marker: "state" });
  });
});

describe("listRepos", () => {
  it("splits linked from unlinked and adds followed repos the poller never saw", async () => {
    const m = manifest({
      repoSettings: { "acme/gadgets": { followed: true }, "acme/hidden": { followed: false } },
    });
    const h = setup({
      manifest: m,
      links: { version: 1, repos: { "acme/widgets": { localPath: "/repo", linkedAt: "t" } } },
      cachedRepos: [{ owner: "acme", name: "widgets" }, { owner: "acme", name: "tools" }],
    });
    const res = (await handlerOf(h.handlers, "skipper:orchestrator:listRepos")(null)) as {
      linked: { key: string }[];
      unlinked: { key: string }[];
    };
    expect(res.linked).toEqual([
      { key: "acme/widgets", localPath: "/repo", linkedAt: "t", baseBranch: undefined, linked: true },
    ]);
    expect(res.unlinked.map((r) => r.key).sort()).toEqual(["acme/gadgets", "acme/tools"]);
  });
});

describe("listRepoSettings", () => {
  it("merges cached, tracked, linked and configured repos into sorted rows", async () => {
    const m = manifest({
      items: { "github:1": trackedItem({ id: "github:1" }) },
      repoSettings: { "acme/configured": { priority: "high" } },
    });
    const h = setup({
      manifest: m,
      links: { version: 1, repos: { "acme/linked": { localPath: "/linked", linkedAt: "t" } } },
      cachedRepos: [{ owner: "Acme", name: "Widgets" }],
      defaultModel: "sonnet",
    });
    const rows = (await handlerOf(h.handlers, "skipper:orchestrator:listRepoSettings")(null)) as {
      key: string;
      repo: RepoRef;
      linked: boolean;
      localPath?: string;
      settings: Record<string, unknown>;
    }[];

    expect(rows.map((r) => r.key)).toEqual([
      "acme/configured",
      "acme/linked",
      "acme/widgets",
    ]);
    // The poll cache wins the RepoRef, so the proper-case owner/name survives.
    expect(rows.find((r) => r.key === "acme/widgets")!.repo).toEqual({
      owner: "Acme",
      name: "Widgets",
    });
    expect(rows.find((r) => r.key === "acme/linked")).toMatchObject({
      linked: true,
      localPath: "/linked",
    });
    expect(rows.find((r) => r.key === "acme/configured")!.settings).toEqual({ priority: "high" });
  });
});

describe("branch listing", () => {
  it("inspectLinkTarget fetches best-effort and returns the local branches", async () => {
    const h = setup();
    fetchOriginMock.mockRejectedValue(new Error("offline"));
    const res = await handlerOf(h.handlers, "skipper:orchestrator:inspectLinkTarget")(
      null,
      "acme",
      "widgets",
      "/repo",
    );
    expect(res).toEqual({ ok: true, branches: ["main"], defaultBranch: "main" });
  });

  it("listRemoteBranches refuses without a token", async () => {
    const h = setup({ token: null });
    const res = await handlerOf(h.handlers, "skipper:orchestrator:listRemoteBranches")(
      null,
      "acme",
      "widgets",
    );
    expect(res).toEqual({ ok: false, error: "no account token available for this repo" });
    expect(listRemoteHeadsMock).not.toHaveBeenCalled();
  });

  it("listRemoteBranches returns the remote heads", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, "skipper:orchestrator:listRemoteBranches")(
      null,
      "acme",
      "widgets",
    );
    expect(res).toEqual({ ok: true, branches: ["main", "develop"], defaultBranch: "main" });
  });

  it("listRepoBranches refuses when the repo is not linked", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, "skipper:orchestrator:listRepoBranches")(
      null,
      "acme",
      "widgets",
    );
    expect(res).toEqual({ ok: false, error: "repo not linked" });
  });
});
