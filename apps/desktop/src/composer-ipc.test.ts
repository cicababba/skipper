import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, ComposerDraft, RepoRef } from "@skipper/shared";
import type { LLMProviderInterface, LLMResponse } from "@skipper/core";
import { clearSelfLoginCache, registerComposerHandlers, type ComposerIpcDeps } from "./composer-ipc";
import { initComposerChat, type ComposerChatDeps } from "./composer-chat";
import { readComposerDraftFile } from "./composer-draft-store";

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

/** A send turn must never reach a real CLI from an IPC test. */
function fakeProvider(): LLMProviderInterface {
  return {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "ask answer" }),
    askStructured: async () => ({}),
    agent: async (): Promise<LLMResponse> => ({ text: "an answer", sessionId: "sess-a" }),
  } as unknown as LLMProviderInterface;
}

beforeEach(() => {
  clearSelfLoginCache();
  initComposerChat(chatDeps, fakeProvider());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerComposerHandlers", () => {
  it("registers every composer channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      "skipper:composer:attach",
      "skipper:composer:cancel",
      "skipper:composer:detach",
      "skipper:composer:dispose",
      "skipper:composer:generateDraft",
      "skipper:composer:getChat",
      "skipper:composer:getSelfLogin",
      "skipper:composer:resume",
      "skipper:composer:saveDraft",
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

// The dispose channel carries the renderer's discard verdict (#272): with it,
// abandoning the composer is what saves the work, and publishing is what doesn't.
describe("composer dispose", () => {
  const CARD: ComposerDraft = {
    issues: [{ title: "web:fix: the topbar jumps", body: "", acceptanceCriteria: [], labels: [] }],
    relations: [],
  };
  let draftsDir: string;

  beforeEach(async () => {
    draftsDir = await mkdtemp(join(tmpdir(), "sk-composer-ipc-drafts-"));
    initComposerChat(
      { ...chatDeps, draftsDir, onDraftsChanged: () => {} } as ComposerChatDeps,
      fakeProvider(),
    );
  });

  afterEach(async () => {
    await rm(draftsDir, { recursive: true, force: true });
  });

  async function startWithCard(handlers: Map<string, Handler>): Promise<string> {
    const started = (await call(handlers, "skipper:composer:start", REPO)) as { chatId: string };
    await call(handlers, "skipper:composer:updateDraft", REPO, started.chatId, CARD, {});
    return started.chatId;
  }

  it("captures the abandoned session when no opts come through", async () => {
    const { handlers } = setup();
    const chatId = await startWithCard(handlers);

    await call(handlers, "skipper:composer:dispose", REPO, chatId);

    expect((await readComposerDraftFile(draftsDir, chatId))?.unfinished).toBe(true);
  });

  it("forwards the discard flag, so nothing is captured", async () => {
    const { handlers } = setup();
    const chatId = await startWithCard(handlers);

    await call(handlers, "skipper:composer:dispose", REPO, chatId, { discard: true });

    expect(await readComposerDraftFile(draftsDir, chatId)).toBeNull();
  });
});

// The attach channel carries the bytes as a structured-clone ArrayBuffer (#281);
// the send channel gained the attachments argument behind it.
describe("composer attachments", () => {
  let attachmentsDir: string;

  beforeEach(async () => {
    attachmentsDir = await mkdtemp(join(tmpdir(), "sk-composer-ipc-attachments-"));
    initComposerChat(
      { ...chatDeps, attachmentsDir, onDraftsChanged: () => {} } as ComposerChatDeps,
      fakeProvider(),
    );
  });

  afterEach(async () => {
    await rm(attachmentsDir, { recursive: true, force: true });
  });

  async function startChat(handlers: Map<string, Handler>): Promise<string> {
    const started = (await call(handlers, "skipper:composer:start", REPO)) as { chatId: string };
    return started.chatId;
  }

  it("writes the ArrayBuffer through attach and reports the saved path", async () => {
    const { handlers } = setup();
    const chatId = await startChat(handlers);
    const bytes = new Uint8Array(Buffer.from("png-bytes")).buffer;

    const res = (await call(handlers, "skipper:composer:attach", REPO, chatId, "shot.png", bytes)) as {
      ok: boolean;
      path: string;
    };

    expect(res).toMatchObject({ ok: true, name: "shot.png", supported: true });
    expect(res.path).toBe(join(attachmentsDir, chatId, "shot.png"));
    expect(await readFile(res.path, "utf-8")).toBe("png-bytes");
  });

  it("dispatches detach onto the driver", async () => {
    const { handlers } = setup();
    const chatId = await startChat(handlers);
    const saved = (await call(
      handlers,
      "skipper:composer:attach",
      REPO,
      chatId,
      "shot.png",
      new Uint8Array([1]).buffer,
    )) as { path: string };

    await expect(
      call(handlers, "skipper:composer:detach", REPO, chatId, saved.path),
    ).resolves.toEqual({ ok: true });
    expect(existsSync(saved.path)).toBe(false);
  });

  it("passes the send handler's fourth argument through to the driver", async () => {
    const { handlers } = setup();
    const chatId = await startChat(handlers);
    const saved = (await call(
      handlers,
      "skipper:composer:attach",
      REPO,
      chatId,
      "shot.png",
      new Uint8Array([1]).buffer,
    )) as { path: string; name: string };

    // The driver rejects a path outside the chat's directory, so a reachable
    // rejection proves the argument arrived rather than being dropped.
    const rejected = (await call(handlers, "skipper:composer:send", REPO, chatId, "read this", [
      { name: "passwd", path: "/etc/passwd" },
    ])) as { ok: boolean; error?: string };
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/outside its chat directory/);

    const accepted = (await call(handlers, "skipper:composer:send", REPO, chatId, "read this", [
      { name: saved.name, path: saved.path },
    ])) as { ok: boolean };
    expect(accepted.ok).toBe(true);
    const chat = (await call(handlers, "skipper:composer:getChat", REPO, chatId)) as {
      messages: { attachments?: unknown }[];
    };
    expect(chat.messages[0].attachments).toEqual([{ name: saved.name, path: saved.path }]);
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
