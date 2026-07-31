import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  listJiraProjects,
  listMembershipProjects,
  listOpenProjectProjects,
  listUserInstallationRepos,
  type OrchestratorManifest,
} from "@skipper/core";
import type { Account, Issue, PullRequest, TrackedItem } from "@skipper/shared";
import type { RepoLinksFile } from "./repo-links";
import { registerIntakeHandlers, type IntakeIpcDeps } from "./intake-ipc";

vi.mock("@skipper/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skipper/core")>();
  return {
    ...actual,
    listUserInstallationRepos: vi.fn(async () => ({ repos: [], installationCount: 0 })),
    listMembershipProjects: vi.fn(async () => []),
    listJiraProjects: vi.fn(async () => []),
    listOpenProjectProjects: vi.fn(async () => []),
  };
});

const listUserInstallationReposMock = vi.mocked(listUserInstallationRepos);
const listMembershipProjectsMock = vi.mocked(listMembershipProjects);
const listJiraProjectsMock = vi.mocked(listJiraProjects);
const listOpenProjectProjectsMock = vi.mocked(listOpenProjectProjects);

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const githubAccount: Account = {
  provider: "github",
  key: "github:1",
  id: "1",
  name: "cicababba",
};
const gitlabAccount: Account = {
  provider: "gitlab",
  key: "gitlab:1",
  id: "1",
  name: "cicababba",
  baseUrl: "https://gitlab.com",
};
const jiraAccount: Account = {
  provider: "jira",
  key: "jira:acme:5",
  id: "5",
  name: "cicababba",
  baseUrl: "https://acme.atlassian.net",
  cloudId: "cloud-1",
};
const openprojectAccount: Account = {
  provider: "openproject",
  key: "openproject:op.acme.dev:9",
  id: "9",
  name: "cicababba",
  baseUrl: "https://op.acme.dev",
  authMethod: "pat",
};

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

function cachedIssue(id: string, owner: string, name: string): Issue {
  return {
    kind: "issue",
    id,
    source: "github",
    sourceRef: { project: `${owner}/${name}`, key: "1" },
    codeHost: "github",
    accountId: githubAccount.key,
    repo: { owner, name },
    key: "1",
    number: 1,
    title: "an issue",
    labels: [],
    assignees: [],
    url: "https://github.com/x/y/issues/1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
  };
}

interface SetupOptions {
  manifest?: OrchestratorManifest;
  links?: RepoLinksFile;
  accounts?: Account[];
  issueAccounts?: Account[];
  cached?: Map<string, Issue | PullRequest>;
}

function setup(opts: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const m = opts.manifest ?? manifest();
  const saveManifest = vi.fn(async () => {});
  const reconcileFromCache = vi.fn(async () => {});
  const snapshot = vi.fn(() => ({ marker: "state" }) as never);
  const deps: IntakeIpcDeps = {
    ipcMain: ipcMain as unknown as IntakeIpcDeps["ipcMain"],
    ensureManifest: async () => m,
    saveManifest,
    ensureRepoLinks: async () => opts.links ?? { version: 1, repos: {} },
    getAccounts: () => opts.accounts ?? [githubAccount],
    issueAccounts: () => opts.issueAccounts ?? opts.accounts ?? [githubAccount],
    getToken: async () => "tok",
    snapshot,
    reconcileFromCache,
    cachedFor: () => opts.cached,
  };
  registerIntakeHandlers(deps);
  return { handlers, m, saveManifest, reconcileFromCache, snapshot };
}

function handlerOf(handlers: Map<string, Handler>, channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  listUserInstallationReposMock.mockResolvedValue({ repos: [], installationCount: 0 } as never);
  listMembershipProjectsMock.mockResolvedValue([] as never);
  listJiraProjectsMock.mockResolvedValue([] as never);
  listOpenProjectProjectsMock.mockResolvedValue([] as never);
});

describe("registerIntakeHandlers", () => {
  it("registers the three intake channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      "skipper:orchestrator:listFollowCandidates",
      "skipper:orchestrator:listTrackerProjects",
      "skipper:orchestrator:setProjectMapping",
    ]);
  });
});

describe("listFollowCandidates", () => {
  const CHANNEL = "skipper:orchestrator:listFollowCandidates";

  it("refuses when no issue-source account is connected", async () => {
    const h = setup({ issueAccounts: [] });
    const res = await handlerOf(h.handlers, CHANNEL)(null);
    expect(res).toEqual({ ok: false, error: "no issue-source account connected" });
  });

  it("keeps the installation entry when the poller saw the same repo", async () => {
    listUserInstallationReposMock.mockResolvedValue({
      repos: [{ owner: "acme", name: "widgets", private: true }],
      installationCount: 1,
      appSlug: "skipper",
    } as never);
    const cached = new Map<string, Issue | PullRequest>([
      ["github:1", cachedIssue("github:1", "acme", "widgets")],
      ["github:2", cachedIssue("github:2", "acme", "gadgets")],
    ]);
    const h = setup({ cached });
    const res = (await handlerOf(h.handlers, CHANNEL)(null)) as {
      ok: true;
      installationCount: number;
      installUrl: string;
      repos: { repo: { name: string }; source: string }[];
    };
    expect(res.installationCount).toBe(1);
    expect(res.installUrl).toBe("https://github.com/apps/skipper/installations/new");
    // Sorted by owner/name, and the installation entry wins over the polled one.
    expect(res.repos.map((r) => [r.repo.name, r.source])).toEqual([
      ["gadgets", "polled"],
      ["widgets", "installation"],
    ]);
  });

  it("falls back to the settings installations URL without an app slug", async () => {
    listUserInstallationReposMock.mockResolvedValue({
      repos: [],
      installationCount: 0,
    } as never);
    const h = setup();
    const res = (await handlerOf(h.handlers, CHANNEL)(null)) as { installUrl: string };
    expect(res.installUrl).toBe("https://github.com/settings/installations");
  });

  it("describes each candidate with its follow, link and active-item state", async () => {
    listUserInstallationReposMock.mockResolvedValue({
      repos: [{ owner: "acme", name: "widgets", private: false }],
      installationCount: 1,
    } as never);
    const item = {
      id: "github:1",
      repo: { owner: "acme", name: "widgets" },
      state: "coding",
    } as unknown as TrackedItem;
    const h = setup({
      manifest: manifest({
        items: { "github:1": item },
        repoSettings: { "acme/widgets": { followed: true } },
      }),
      links: { version: 1, repos: { "acme/widgets": { localPath: "/repo", linkedAt: "t" } } },
    });
    const res = (await handlerOf(h.handlers, CHANNEL)(null)) as {
      repos: { followed: boolean; linked: boolean; activeItems: number }[];
    };
    expect(res.repos[0]).toMatchObject({ followed: true, linked: true, activeItems: 1 });
  });

  it("uses the membership listing for a GitLab account", async () => {
    listMembershipProjectsMock.mockResolvedValue([
      { repo: { owner: "acme", name: "widgets" }, private: true },
    ] as never);
    const h = setup({ accounts: [gitlabAccount] });
    const res = (await handlerOf(h.handlers, CHANNEL)(null)) as {
      repos: { source: string }[];
      installationCount?: number;
    };
    expect(res.repos[0]!.source).toBe("membership");
    expect(res.installationCount).toBeUndefined();
    expect(listUserInstallationReposMock).not.toHaveBeenCalled();
  });

  it("filters the account by key and provider", async () => {
    const h = setup({ accounts: [githubAccount, gitlabAccount] });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "gitlab:1", "github");
    expect(res).toEqual({ ok: false, error: "no issue-source account connected" });
  });

  it("returns the adapter error", async () => {
    listUserInstallationReposMock.mockRejectedValue(new Error("403 from GitHub"));
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null);
    expect(res).toEqual({ ok: false, error: "403 from GitHub" });
  });
});

describe("setProjectMapping (#79)", () => {
  const CHANNEL = "skipper:orchestrator:setProjectMapping";

  it("no-ops on an invalid mapping key", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "not-a-key", "acme/widgets");
    expect(res).toEqual({ marker: "state" });
    expect(h.m.projectMappings).toEqual({});
    expect(h.saveManifest).not.toHaveBeenCalled();
    expect(h.reconcileFromCache).not.toHaveBeenCalled();
  });

  it("no-ops on an invalid repo value", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(
      null,
      "jira:acme.atlassian.net:PROJ",
      "not a repo",
    );
    expect(res).toEqual({ marker: "state" });
    expect(h.m.projectMappings).toEqual({});
    expect(h.saveManifest).not.toHaveBeenCalled();
  });

  it("writes the canonical key and reconciles", async () => {
    const h = setup();
    await handlerOf(h.handlers, CHANNEL)(null, "jira:ACME.atlassian.NET:PROJ", "acme/widgets");
    expect(Object.keys(h.m.projectMappings)).toEqual(["jira:acme.atlassian.net:PROJ"]);
    expect(h.m.projectMappings["jira:acme.atlassian.net:PROJ"]).toBe("acme/widgets");
    expect(h.saveManifest).toHaveBeenCalledTimes(1);
    expect(h.reconcileFromCache).toHaveBeenCalledTimes(1);
  });

  it("deletes the mapping on a null repo", async () => {
    const h = setup({
      manifest: manifest({ projectMappings: { "jira:acme.atlassian.net:PROJ": "acme/widgets" } }),
    });
    await handlerOf(h.handlers, CHANNEL)(null, "jira:acme.atlassian.net:PROJ", null);
    expect(h.m.projectMappings).toEqual({});
    expect(h.saveManifest).toHaveBeenCalledTimes(1);
    expect(h.reconcileFromCache).toHaveBeenCalledTimes(1);
  });
});

describe("listTrackerProjects (#79)", () => {
  const CHANNEL = "skipper:orchestrator:listTrackerProjects";

  it("refuses an unknown account", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "jira:nope");
    expect(res).toEqual({ ok: false, error: "unknown account" });
  });

  it("lists Jira projects with the mapping host", async () => {
    listJiraProjectsMock.mockResolvedValue([{ key: "PROJ", name: "Project" }] as never);
    const h = setup({ accounts: [jiraAccount] });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "jira:acme:5");
    expect(res).toEqual({
      ok: true,
      source: "jira",
      host: "acme.atlassian.net",
      projects: [{ key: "PROJ", name: "Project" }],
    });
  });

  it("refuses an OpenProject account without an instance URL", async () => {
    const h = setup({ accounts: [{ ...openprojectAccount, baseUrl: undefined }] });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "openproject:op.acme.dev:9");
    expect(res).toEqual({ ok: false, error: "account has no instance URL" });
    expect(listOpenProjectProjectsMock).not.toHaveBeenCalled();
  });

  it("lists OpenProject projects", async () => {
    listOpenProjectProjectsMock.mockResolvedValue([{ key: "5", name: "Widgets" }] as never);
    const h = setup({ accounts: [openprojectAccount] });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "openproject:op.acme.dev:9");
    expect(res).toEqual({
      ok: true,
      source: "openproject",
      host: "op.acme.dev",
      projects: [{ key: "5", name: "Widgets" }],
    });
  });

  it("refuses a provider that carries its own repos", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "github:1");
    expect(res).toEqual({ ok: false, error: "account does not support project mapping" });
  });

  it("returns the adapter error", async () => {
    listJiraProjectsMock.mockRejectedValue(new Error("401 unauthorized"));
    const h = setup({ accounts: [jiraAccount] });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "jira:acme:5");
    expect(res).toEqual({ ok: false, error: "401 unauthorized" });
  });
});
