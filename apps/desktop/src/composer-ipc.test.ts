import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import type { Account, RepoRef } from "@skipper/shared";
import { clearSelfLoginCache, registerComposerHandlers, type ComposerIpcDeps } from "./composer-ipc";
import { initComposerChat, type ComposerChatDeps } from "./composer-chat";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const REPO: RepoRef = { owner: "acme", name: "widgets" };

const githubAccount: Account = { provider: "github", key: "github:1234", id: "1234", name: "Cica" };

/** First argument of the first fetch call — vi.fn()'s inferred tuple is empty. */
function fetchedUrl(mock: { mock: { calls: unknown[][] } }): string {
  return String(mock.mock.calls[0][0]);
}

function setup(opts: { accounts?: Account[]; token?: string | null } = {}) {
  const handlers = new Map<string, Handler>();
  const getToken = vi.fn(async () => (opts.token === undefined ? "tok-abc" : opts.token));
  const deps = {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    getAccounts: () => opts.accounts ?? [githubAccount],
    getToken,
  } as unknown as ComposerIpcDeps;
  registerComposerHandlers(deps);
  return { handlers, getToken };
}

async function call(
  handlers: Map<string, Handler>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler(null, ...args);
}

const chatDeps = {
  getRepoPath: () => "/checkout/widgets",
  getRepoSettings: () => ({ composerModel: "opus", composerRuntime: "claude-cli" }),
  getLlmSettings: async () => ({}),
  checkoutDirtyPaths: async () => [],
  emitEvent: () => {},
  getRepoInstructions: async () => undefined,
  getGraphify: () => undefined,
} as unknown as ComposerChatDeps;

beforeEach(() => {
  clearSelfLoginCache();
  initComposerChat(chatDeps);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerComposerHandlers", () => {
  it("registers every composer channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      "skipper:composer:cancel",
      "skipper:composer:dispose",
      "skipper:composer:generateDraft",
      "skipper:composer:getChat",
      "skipper:composer:getSelfLogin",
      "skipper:composer:send",
      "skipper:composer:start",
      "skipper:composer:updateDraft",
    ]);
  });

  it("dispatches start / getChat / dispose onto the driver", async () => {
    const { handlers } = setup();
    const started = (await call(handlers, "skipper:composer:start", REPO)) as { chatId: string };
    expect(started).toMatchObject({ ok: true });
    await expect(call(handlers, "skipper:composer:getChat", REPO, started.chatId)).resolves.toEqual({
      messages: [],
    });
    await call(handlers, "skipper:composer:dispose", REPO, started.chatId);
    await expect(
      call(handlers, "skipper:composer:getChat", REPO, started.chatId),
    ).resolves.toBeNull();
  });

  it("dispatches updateDraft onto the driver's record", async () => {
    const { handlers } = setup();
    const started = (await call(handlers, "skipper:composer:start", REPO)) as { chatId: string };
    const draft = {
      issues: [{ title: "t", body: "b", acceptanceCriteria: [], labels: [] }],
      relations: [],
    };
    await expect(
      call(handlers, "skipper:composer:updateDraft", REPO, started.chatId, draft, { 0: ["title"] }),
    ).resolves.toEqual({ ok: true });
    await expect(
      call(handlers, "skipper:composer:getChat", REPO, started.chatId),
    ).resolves.toMatchObject({ draft, editedFlags: { 0: ["title"] } });
  });
});

describe("getSelfLogin", () => {
  it("returns the login stored on the account without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { handlers } = setup({ accounts: [{ ...githubAccount, login: "cicababba" }] });
    await expect(call(handlers, "skipper:composer:getSelfLogin", "github:1234")).resolves.toEqual({
      login: "cicababba",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a legacy GitHub account's login once and caches it", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ login: "cicababba" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { handlers, getToken } = setup();

    await expect(call(handlers, "skipper:composer:getSelfLogin", "github:1234")).resolves.toEqual({
      login: "cicababba",
    });
    await expect(call(handlers, "skipper:composer:getSelfLogin", "github:1234")).resolves.toEqual({
      login: "cicababba",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchedUrl(fetchMock)).toBe("https://api.github.com/user");
    expect(getToken).toHaveBeenCalledWith("github:1234");
  });

  it("hits the account's own host on GitHub Enterprise", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ login: "cica" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { handlers } = setup({
      accounts: [{ ...githubAccount, baseUrl: "https://ghe.acme.dev/api/v3" }],
    });
    await call(handlers, "skipper:composer:getSelfLogin", "github:1234");
    expect(fetchedUrl(fetchMock)).toBe("https://ghe.acme.dev/api/v3/user");
  });

  it("returns no login for a non-GitHub provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { handlers } = setup({
      accounts: [{ provider: "jira", key: "jira:9", id: "9", name: "Cica" }],
    });
    await expect(call(handlers, "skipper:composer:getSelfLogin", "jira:9")).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns no login when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const { handlers } = setup();
    await expect(call(handlers, "skipper:composer:getSelfLogin", "github:1234")).resolves.toEqual({});
  });

  it("returns no login for an unknown account", async () => {
    const { handlers } = setup();
    await expect(call(handlers, "skipper:composer:getSelfLogin", "github:none")).resolves.toEqual({});
  });
});
