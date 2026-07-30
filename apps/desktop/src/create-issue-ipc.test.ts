import { describe, expect, it, vi } from "vitest";
import { registerCreateIssueHandlers, type CreateIssueIpcDeps } from "./create-issue-ipc";
import type { Account, CreateIssueOnTrackerParams, Issue } from "@skipper/shared";
import type { IssueSource } from "@skipper/core";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const CHANNEL = "skipper:orchestrator:createIssueOnTracker";

const account: Account = {
  provider: "github",
  key: "github:1234",
  id: "1234",
  name: "cicababba",
};

const jiraAccount: Account = {
  provider: "jira",
  key: "jira:acme:5678",
  id: "5678",
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

const createdIssue = {
  kind: "issue",
  id: "github:99887766",
  source: "github",
  accountId: "github:1234",
  repo: { owner: "acme", name: "widgets" },
  key: "42",
  number: 42,
  title: "test from skipper",
  url: "https://github.com/acme/widgets/issues/42",
  state: "open",
  updatedAt: "2026-07-29T10:00:00.000Z",
} as unknown as Issue;

/** Jira numbers nothing — the result carries a key and no number. */
const createdJiraIssue = {
  kind: "issue",
  id: "jira:10101",
  source: "jira",
  accountId: "jira:acme:5678",
  key: "PROJ-123",
  title: "test from skipper",
  url: "https://acme.atlassian.net/browse/PROJ-123",
  state: "open",
  updatedAt: "2026-07-29T10:00:00.000Z",
} as unknown as Issue;

interface SetupOptions {
  accounts?: Account[];
  /** undefined = no source for the provider; null = a source without createIssue. */
  source?: IssueSource | null | undefined;
  sourceId?: string;
  created?: Issue;
  createThrows?: Error;
  token?: string | null;
  projectMappings?: Record<string, string>;
}

function setup(opts: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const createIssue = vi.fn(async () => {
    if (opts.createThrows) throw opts.createThrows;
    return opts.created ?? createdIssue;
  });
  const defaultSource = { id: opts.sourceId ?? "github", createIssue } as unknown as IssueSource;
  const source = "source" in opts ? opts.source : defaultSource;
  const getToken = vi.fn(async () => opts.token ?? "tok-abc");
  const sourceForProvider = vi.fn(() => source ?? undefined);
  const getProjectMappings = vi.fn(async () => opts.projectMappings ?? {});
  const deps = {
    ipcMain,
    getAccounts: () => opts.accounts ?? [account],
    getToken,
    sourceForProvider,
    getProjectMappings,
  } as unknown as CreateIssueIpcDeps;
  registerCreateIssueHandlers(deps);
  return { handlers, createIssue, getToken, sourceForProvider, getProjectMappings };
}

function handlerOf(handlers: Map<string, Handler>): Handler {
  const handler = handlers.get(CHANNEL);
  if (!handler) throw new Error("handler not registered");
  return handler;
}

function params(overrides: Partial<CreateIssueOnTrackerParams> = {}): CreateIssueOnTrackerParams {
  return {
    accountId: "github:1234",
    repo: { owner: "acme", name: "widgets" },
    title: "test from skipper",
    ...overrides,
  };
}

describe("registerCreateIssueHandlers", () => {
  it("registers the createIssueOnTracker channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([CHANNEL]);
  });

  it("rejects a blank title without resolving a source", async () => {
    const { handlers, sourceForProvider, createIssue } = setup();
    const res = await handlerOf(handlers)(null, params({ title: "   " }));
    expect(res).toEqual({ ok: false, error: "title is required" });
    expect(sourceForProvider).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("rejects a blank repo owner or name", async () => {
    const { handlers, createIssue } = setup();
    const handler = handlerOf(handlers);
    const noOwner = await handler(null, params({ repo: { owner: "  ", name: "widgets" } }));
    const noName = await handler(null, params({ repo: { owner: "acme", name: "" } }));
    expect(noOwner).toEqual({ ok: false, error: "repo owner and name are required" });
    expect(noName).toEqual({ ok: false, error: "repo owner and name are required" });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("rejects an unknown accountId", async () => {
    const { handlers, sourceForProvider } = setup();
    const res = await handlerOf(handlers)(null, params({ accountId: "github:nope" }));
    expect(res).toEqual({ ok: false, error: "unknown account github:nope" });
    expect(sourceForProvider).not.toHaveBeenCalled();
  });

  it("reports not supported when the provider has no issue source", async () => {
    const { handlers } = setup({ source: undefined });
    const res = await handlerOf(handlers)(null, params());
    expect(res).toEqual({
      ok: false,
      error: "issue creation is not supported for github",
    });
  });

  it("reports not supported when the source lacks createIssue", async () => {
    const { handlers } = setup({ source: { poll: vi.fn() } as unknown as IssueSource });
    const res = await handlerOf(handlers)(null, params());
    expect(res).toEqual({
      ok: false,
      error: "issue creation is not supported for github",
    });
  });

  it("creates the issue and returns its ref", async () => {
    const withBaseUrl: Account = { ...account, baseUrl: "https://ghe.acme.dev" };
    const { handlers, createIssue, getToken } = setup({ accounts: [withBaseUrl] });
    const res = await handlerOf(handlers)(
      null,
      params({
        title: "  test from skipper  ",
        repo: { owner: " acme ", name: " widgets " },
        body: "steps to reproduce",
        labels: ["bug", "web"],
      }),
    );

    expect(res).toEqual({
      ok: true,
      id: "github:99887766",
      key: "42",
      number: 42,
      url: "https://github.com/acme/widgets/issues/42",
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    const [createParams, tokenProvider, baseUrl] = createIssue.mock.calls[0] as unknown as [
      Record<string, unknown>,
      (force?: boolean) => Promise<string | null>,
      string | undefined,
    ];
    expect(createParams).toEqual({
      repo: { owner: "acme", name: "widgets" },
      title: "test from skipper",
      body: "steps to reproduce",
      labels: ["bug", "web"],
      accountId: "github:1234",
    });
    expect(baseUrl).toBe("https://ghe.acme.dev");

    await expect(tokenProvider(true)).resolves.toBe("tok-abc");
    expect(getToken).toHaveBeenCalledWith("github:1234", true);
  });

  // #136: self-assign rides through to the adapter untouched.
  it("passes assignees through to the source", async () => {
    const { handlers, createIssue } = setup();
    await handlerOf(handlers)(null, params({ assignees: ["cicababba"] }));
    const [createParams] = createIssue.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(createParams.assignees).toEqual(["cicababba"]);
  });

  it("leaves assignees undefined when the caller omits them", async () => {
    const { handlers, createIssue } = setup();
    await handlerOf(handlers)(null, params());
    const [createParams] = createIssue.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(createParams.assignees).toBeUndefined();
  });

  it("returns the adapter error when creation throws", async () => {
    const { handlers } = setup({
      createThrows: new Error("Resource not accessible by integration"),
    });
    const res = await handlerOf(handlers)(null, params());
    expect(res).toEqual({
      ok: false,
      error: "Resource not accessible by integration",
    });
  });

  // #274: repo-scoped trackers never consult the project→repo mapping.
  it("does not look up project mappings for GitHub", async () => {
    const { handlers, createIssue, getProjectMappings } = setup();
    await handlerOf(handlers)(null, params());
    expect(getProjectMappings).not.toHaveBeenCalled();
    const [createParams] = createIssue.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(createParams).not.toHaveProperty("project");
  });

  it("passes cloudId and authMethod through to the adapter", async () => {
    const { handlers, createIssue } = setup({
      accounts: [openprojectAccount],
      sourceId: "openproject",
      projectMappings: { "openproject:op.acme.dev:5": "acme/widgets" },
    });
    await handlerOf(handlers)(null, params({ accountId: "openproject:op.acme.dev:9" }));

    const [, , baseUrl, cloudId, authMethod] = createIssue.mock.calls[0] as unknown as [
      Record<string, unknown>,
      unknown,
      string | undefined,
      string | undefined,
      string | undefined,
    ];
    expect(baseUrl).toBe("https://op.acme.dev");
    expect(cloudId).toBeUndefined();
    expect(authMethod).toBe("pat");
  });
});

describe("registerCreateIssueHandlers — project-scoped trackers (#274)", () => {
  const jiraParams = params({ accountId: "jira:acme:5678" });

  it("resolves the Jira project from the mapping and returns a key without a number", async () => {
    const { handlers, createIssue, getProjectMappings } = setup({
      accounts: [jiraAccount],
      sourceId: "jira",
      created: createdJiraIssue,
      projectMappings: { "jira:acme.atlassian.net:PROJ": "acme/widgets" },
    });

    const res = await handlerOf(handlers)(null, jiraParams);

    expect(getProjectMappings).toHaveBeenCalledTimes(1);
    const [createParams, , baseUrl, cloudId] = createIssue.mock.calls[0] as unknown as [
      Record<string, unknown>,
      unknown,
      string | undefined,
      string | undefined,
    ];
    expect(createParams.project).toBe("PROJ");
    expect(baseUrl).toBe("https://acme.atlassian.net");
    expect(cloudId).toBe("cloud-1");
    expect(res).toEqual({
      ok: true,
      id: "jira:10101",
      key: "PROJ-123",
      url: "https://acme.atlassian.net/browse/PROJ-123",
    });
  });

  it("passes the numeric project id for OpenProject", async () => {
    const { handlers, createIssue } = setup({
      accounts: [openprojectAccount],
      sourceId: "openproject",
      projectMappings: { "openproject:op.acme.dev:5": "acme/widgets" },
    });

    await handlerOf(handlers)(null, params({ accountId: "openproject:op.acme.dev:9" }));

    const [createParams] = createIssue.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(createParams.project).toBe("5");
  });

  it("refuses with an actionable error when the repo has no project mapping", async () => {
    const { handlers, createIssue } = setup({
      accounts: [jiraAccount],
      sourceId: "jira",
      projectMappings: {},
    });

    const res = await handlerOf(handlers)(null, jiraParams);

    expect(res).toEqual({
      ok: false,
      error: "no jira project is mapped to acme/widgets — add the mapping in Settings",
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("refuses and lists the candidates when the repo maps to several projects", async () => {
    const { handlers, createIssue } = setup({
      accounts: [jiraAccount],
      sourceId: "jira",
      projectMappings: {
        "jira:acme.atlassian.net:ZETA": "acme/widgets",
        "jira:acme.atlassian.net:ALPHA": "acme/widgets",
      },
    });

    const res = await handlerOf(handlers)(null, jiraParams);

    expect(res).toEqual({
      ok: false,
      error:
        "acme/widgets is mapped to more than one jira project (ALPHA, ZETA) — leave a single mapping in Settings",
    });
    expect(createIssue).not.toHaveBeenCalled();
  });
});
