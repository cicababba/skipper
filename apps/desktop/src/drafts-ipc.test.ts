import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComposerDraftListItem, RepoRef, StoredComposerDraft } from "@skipper/shared";
import { registerDraftsHandlers, type DraftsIpcDeps } from "./drafts-ipc";
import { readComposerDraftFile, saveComposerDraftFile } from "./composer-draft-store";
import {
  initComposerChat,
  saveComposerDraft,
  startComposerChat,
  updateComposerDraft,
  type ComposerChatDeps,
} from "./composer-chat";

// The #138 drafts handlers against a real on-disk store with a fake ipcMain
// (pattern from composer-ipc.test.ts / memory-ipc.test.ts) — no Electron.

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const REPO: RepoRef = { owner: "acme", name: "widgets" };

let draftsDir: string;

beforeEach(async () => {
  draftsDir = await mkdtemp(join(tmpdir(), "sk-drafts-ipc-"));
});

afterEach(async () => {
  await rm(draftsDir, { recursive: true, force: true });
});

function setup() {
  const handlers = new Map<string, Handler>();
  const notifyChanged = vi.fn();
  const deps = {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    draftsDir,
    notifyChanged,
  } as unknown as DraftsIpcDeps;
  registerDraftsHandlers(deps);
  return { handlers, notifyChanged };
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

function makeDraft(over: Partial<StoredComposerDraft> = {}): StoredComposerDraft {
  return {
    version: 1,
    draftId: "draft-1",
    repo: REPO,
    chatId: "draft-1",
    title: "web:feat: rate-limit the webhook",
    messages: [],
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T10:00:00.000Z",
    ...over,
  };
}

/** The composer driver, wired at the same drafts dir — enough of it to promote a
 *  chat and let an autosave fire; no provider, so no turn ever runs. */
function initChatDriver(): ComposerChatDeps {
  const deps = {
    getRepoPath: () => "/checkout/widgets",
    getRepoSettings: () => ({ composerModel: "opus", composerRuntime: "claude-cli" }),
    getLlmSettings: async () => ({}),
    checkoutDirtyPaths: async () => [],
    emitEvent: () => {},
    getRepoInstructions: async () => undefined,
    getGraphify: () => undefined,
    draftsDir,
    onDraftsChanged: () => {},
  } as unknown as ComposerChatDeps;
  initComposerChat(deps);
  return deps;
}

/** Autosave is fire-and-forget: give it a wall-clock budget to land (or not). */
async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("registerDraftsHandlers", () => {
  it("registers every drafts channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(["skipper:drafts:delete", "skipper:drafts:list"]);
  });
});

describe("skipper:drafts:list", () => {
  it("returns the saved drafts, most recently touched first", async () => {
    await saveComposerDraftFile(
      draftsDir,
      makeDraft({ draftId: "old", chatId: "old", updatedAt: "2026-07-20T09:00:00.000Z" }),
    );
    await saveComposerDraftFile(
      draftsDir,
      makeDraft({ draftId: "fresh", chatId: "fresh", updatedAt: "2026-07-28T09:00:00.000Z" }),
    );
    const { handlers } = setup();

    const list = (await call(handlers, "skipper:drafts:list")) as ComposerDraftListItem[];
    expect(list.map((d) => d.draftId)).toEqual(["fresh", "old"]);
    expect(list[0]).toEqual({
      draftId: "fresh",
      repo: REPO,
      title: "web:feat: rate-limit the webhook",
      updatedAt: "2026-07-28T09:00:00.000Z",
      quick: true,
    });
  });

  it("is empty before anything was saved", async () => {
    const { handlers } = setup();
    await expect(call(handlers, "skipper:drafts:list")).resolves.toEqual([]);
  });
});

describe("skipper:drafts:delete", () => {
  it("unlinks the file and notifies the renderer", async () => {
    await saveComposerDraftFile(draftsDir, makeDraft());
    const { handlers, notifyChanged } = setup();

    await expect(call(handlers, "skipper:drafts:delete", "draft-1")).resolves.toEqual({ ok: true });
    expect(await readComposerDraftFile(draftsDir, "draft-1")).toBeNull();
    expect(notifyChanged).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown draft and notifies nobody", async () => {
    const { handlers, notifyChanged } = setup();
    await expect(call(handlers, "skipper:drafts:delete", "nope")).resolves.toEqual({
      ok: false,
      error: "no draft nope",
    });
    expect(notifyChanged).not.toHaveBeenCalled();
  });

  // Without the demotion the live chat would still hold the draft id, and its
  // next commit point would write the deleted file straight back to disk.
  it("demotes the live chat so autosave cannot resurrect the file", async () => {
    initChatDriver();
    const started = startComposerChat(REPO);
    if (!started.ok) throw new Error(started.error);
    const saved = await saveComposerDraft(REPO, started.chatId);
    expect(saved).toEqual({ ok: true, draftId: started.chatId });

    const { handlers } = setup();
    await expect(call(handlers, "skipper:drafts:delete", started.chatId)).resolves.toEqual({
      ok: true,
    });

    updateComposerDraft(
      REPO,
      started.chatId,
      { issues: [{ title: "mine", body: "", acceptanceCriteria: [], labels: [] }], relations: [] },
      { 0: ["title"] },
    );
    await settle();
    expect(await readComposerDraftFile(draftsDir, started.chatId)).toBeNull();
  });

  it("leaves other chats' drafts promoted", async () => {
    initChatDriver();
    const one = startComposerChat(REPO);
    const two = startComposerChat(REPO);
    if (!one.ok || !two.ok) throw new Error("start failed");
    await saveComposerDraft(REPO, one.chatId);
    await saveComposerDraft(REPO, two.chatId);

    const { handlers } = setup();
    await call(handlers, "skipper:drafts:delete", one.chatId);

    updateComposerDraft(REPO, two.chatId, { issues: [], relations: [] }, {});
    await settle();
    expect(await readComposerDraftFile(draftsDir, two.chatId)).not.toBeNull();
    expect(await readComposerDraftFile(draftsDir, one.chatId)).toBeNull();
  });
});
