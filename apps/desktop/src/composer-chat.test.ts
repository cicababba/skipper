import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodingEvent,
  ComposerDraft,
  LlmSettings,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredComposerDraft,
} from "@skipper/shared";
import { CHAT_TURN_DETAILS, DEFAULT_LLM_SETTINGS, isPlanChatText } from "@skipper/shared";
import type { GraphifyContext, LLMProviderInterface, LLMResponse } from "@skipper/core";
import {
  cancelComposerChat,
  demoteComposerDraft,
  disposeComposerChat,
  generateComposerDraft,
  getComposerChat,
  initComposerChat,
  resumeComposerChat,
  saveComposerDraft,
  sendComposerChatMessage,
  startComposerChat,
  updateComposerDraft,
  type ComposerChatDeps,
} from "./composer-chat";
import { readComposerDraftFile, saveComposerDraftFile } from "./composer-draft-store";

const REPO: RepoRef = { owner: "acme", name: "widgets" };

let draftsDir: string;

beforeEach(async () => {
  draftsDir = await mkdtemp(join(tmpdir(), "sk-composer-drafts-"));
});

afterEach(async () => {
  await rm(draftsDir, { recursive: true, force: true });
});

const DRAFT_JSON = JSON.stringify({
  issues: [
    { title: "web:feat: a thing", body: "do it", acceptanceCriteria: ["works"], labels: ["web"] },
    { title: "core:test: cover it", body: "tests", acceptanceCriteria: [], labels: ["core"] },
  ],
  relations: [{ from: 1, to: 0, kind: "blocks" }],
});

const GRAPHIFY: GraphifyContext = {
  mcp: { mcpBinPath: "/tools/graphify-mcp", graphPath: "/graphs/acme_widgets/graph.json" },
  indexedSha: "abc1234",
};

interface Harness {
  deps: ComposerChatDeps;
  events: { key: string; event: CodingEvent }[];
  draftChanges: { count: number };
}

function makeHarness(over: Partial<ComposerChatDeps> = {}): Harness {
  const events: { key: string; event: CodingEvent }[] = [];
  const draftChanges = { count: 0 };
  const deps: ComposerChatDeps = {
    getRepoPath: () => "/checkout/widgets",
    getRepoSettings: () =>
      ({ composerModel: "opus", composerRuntime: "claude-cli" }) as unknown as ResolvedRepoOrchestratorSettings,
    getLlmSettings: async (): Promise<LlmSettings> => ({ ...DEFAULT_LLM_SETTINGS }),
    checkoutDirtyPaths: async () => [],
    emitEvent: (key, event) => events.push({ key, event }),
    getRepoInstructions: async () => undefined,
    getGraphify: () => undefined,
    draftsDir,
    onDraftsChanged: () => {
      draftChanges.count++;
    },
    ...over,
  };
  return { deps, events, draftChanges };
}

/** Autosave is fire-and-forget, so the file lands after the call returns. Polls
 *  on wall-clock time so a loaded CI box doesn't turn a slow write into a
 *  failure; the negative assertions use `settle` instead. */
async function waitForDraft(
  draftId: string,
  predicate: (draft: StoredComposerDraft) => boolean,
): Promise<StoredComposerDraft> {
  const deadline = Date.now() + 2000;
  let last: StoredComposerDraft | null = null;
  while (Date.now() < deadline) {
    last = await readComposerDraftFile(draftsDir, draftId);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`draft ${draftId} never matched: ${JSON.stringify(last)}`);
}

async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeProvider(
  agentImpl?: (prompt: string, opts?: Record<string, unknown>) => Promise<LLMResponse>,
): LLMProviderInterface & { agent: ReturnType<typeof vi.fn> } {
  const agent = vi.fn(
    agentImpl ?? (async (): Promise<LLMResponse> => ({ text: "an answer", sessionId: "sess-a" })),
  );
  return {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "ask answer" }),
    askStructured: async () => ({}),
    agent,
  } as unknown as LLMProviderInterface & { agent: ReturnType<typeof vi.fn> };
}

function start(): string {
  const res = startComposerChat(REPO);
  if (!res.ok) throw new Error(res.error);
  return res.chatId;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("startComposerChat", () => {
  it("mints a chat id and opens the stream with the one fetching reset", () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const res = startComposerChat(REPO);
    expect(res.ok).toBe(true);
    const chatId = (res as { chatId: string }).chatId;
    expect(chatId).toMatch(/[0-9a-f-]{36}/);
    expect(h.events).toEqual([
      { key: `acme/widgets:${chatId}`, event: { kind: "status", phase: "fetching", detail: "composer start" } },
    ]);
    expect(getComposerChat(REPO, chatId)).toEqual({ messages: [] });
  });

  it("refuses a repo that is not linked", () => {
    const h = makeHarness({ getRepoPath: () => undefined });
    initComposerChat(h.deps, fakeProvider());
    expect(startComposerChat(REPO)).toEqual({ ok: false, error: "repo not linked" });
  });
});

describe("sendComposerChatMessage", () => {
  it("runs a fresh seeded turn and appends both messages", async () => {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();

    const res = await sendComposerChatMessage(REPO, chatId, "rate-limit the webhook");
    expect(res).toEqual({ ok: true, reply: "an answer" });
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBeUndefined();
    expect(typeof opts.sessionId).toBe("string");
    expect(opts.cwd).toBe("/checkout/widgets");
    const chat = getComposerChat(REPO, chatId);
    expect(chat?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual([
      "rate-limit the webhook",
      "an answer",
    ]);
  });

  it("opens the turn with its own resuming detail and never a fetching reset", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    h.events.length = 0;

    await sendComposerChatMessage(REPO, chatId, "hi");
    expect(h.events[0].event).toEqual({
      kind: "status",
      phase: "resuming",
      detail: CHAT_TURN_DETAILS.composerChat,
    });
    expect(
      h.events.some((e) => e.event.kind === "status" && e.event.phase === "fetching"),
    ).toBe(false);
  });

  it("seeds the second turn by resuming the first turn's session", async () => {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();

    await sendComposerChatMessage(REPO, chatId, "first");
    await sendComposerChatMessage(REPO, chatId, "second");
    // The record-before-run minted id is the lineage the second turn resumes.
    const minted = (provider.agent.mock.calls[0][1] as Record<string, unknown>).sessionId;
    const opts = provider.agent.mock.calls[1][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBe(minted);
    expect(provider.agent.mock.calls[1][0] as string).toContain("User: second");
  });

  it("retries fresh once when a dead resume fails without events", async () => {
    let call = 0;
    const provider = fakeProvider(async () => {
      call++;
      if (call === 2) throw new Error("session not found");
      return { text: "recovered", sessionId: "sess-a" };
    });
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();

    await sendComposerChatMessage(REPO, chatId, "first");
    const res = await sendComposerChatMessage(REPO, chatId, "second");
    expect(res).toEqual({ ok: true, reply: "recovered" });
    expect(provider.agent).toHaveBeenCalledTimes(3);
    const retryOpts = provider.agent.mock.calls[2][1] as Record<string, unknown>;
    expect(retryOpts.resumeSessionId).toBeUndefined();
    // The fresh retry re-seeds the transcript.
    expect(provider.agent.mock.calls[2][0] as string).toContain("--- Conversation so far ---");
  });

  it("busy-guards a concurrent turn on the same chat", async () => {
    const gate = deferred<LLMResponse>();
    const provider = fakeProvider(() => gate.promise);
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();

    const first = sendComposerChatMessage(REPO, chatId, "one");
    const second = await sendComposerChatMessage(REPO, chatId, "two");
    expect(second).toEqual({ ok: false, error: "chat turn already running" });
    gate.resolve({ text: "done" });
    await first;
  });

  it("records nothing when the turn is cancelled", async () => {
    const gate = deferred<LLMResponse>();
    const provider = fakeProvider(() => gate.promise);
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();

    const pending = sendComposerChatMessage(REPO, chatId, "one");
    cancelComposerChat(REPO, chatId);
    gate.resolve({ text: "too late" });
    expect(await pending).toEqual({ ok: false, cancelled: true });
    expect(getComposerChat(REPO, chatId)?.messages).toEqual([]);
  });

  it("fails the turn when it dirtied the checkout", async () => {
    let calls = 0;
    const h = makeHarness({ checkoutDirtyPaths: async () => (calls++ === 0 ? [] : ["?? stray.ts"]) });
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();

    const res = await sendComposerChatMessage(REPO, chatId, "hi");
    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toMatch(/escaped the worktree/);
    expect(getComposerChat(REPO, chatId)?.messages).toEqual([]);
  });

  it("threads the repo conventions and the graph into the core call", async () => {
    const provider = fakeProvider();
    const h = makeHarness({
      getRepoInstructions: async () => "Prefix titles with the scope.",
      getGraphify: async () => GRAPHIFY,
    });
    initComposerChat(h.deps, provider);
    const chatId = start();

    await sendComposerChatMessage(REPO, chatId, "hi");
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.systemPrompt).toContain("Prefix titles with the scope.");
    expect(opts.graph).toEqual(GRAPHIFY.mcp);
  });

  it("rejects an unknown chat", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    expect(await sendComposerChatMessage(REPO, "nope", "hi")).toEqual({
      ok: false,
      error: "unknown composer chat",
    });
  });
});

describe("updateComposerDraft", () => {
  it("round-trips into the next turn's prompt with the edit markers", async () => {
    const provider = fakeProvider();
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "first");

    const draft: ComposerDraft = {
      issues: [{ title: "my own title", body: "b", acceptanceCriteria: [], labels: [] }],
      relations: [],
    };
    expect(updateComposerDraft(REPO, chatId, draft, { 0: ["title"] })).toEqual({ ok: true });
    expect(getComposerChat(REPO, chatId)).toMatchObject({ draft, editedFlags: { 0: ["title"] } });

    await sendComposerChatMessage(REPO, chatId, "second");
    const prompt = provider.agent.mock.calls[1][0] as string;
    expect(prompt).toContain("--- Current draft ---");
    expect(prompt).toContain("my own title");
    expect(prompt).toContain("[edited by user");
  });

  it("rejects an unknown chat", () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    expect(updateComposerDraft(REPO, "nope", { issues: [], relations: [] }, {})).toEqual({
      ok: false,
      error: "unknown composer chat",
    });
  });
});

describe("generateComposerDraft", () => {
  it("refuses before any discussion happened", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    expect(await generateComposerDraft(REPO, chatId)).toEqual({
      ok: false,
      error: "no discussion to distill",
    });
  });

  it("stores the draft, clears the edit flags and adopts the distill session", async () => {
    const provider = fakeProvider(async (_p, opts) => {
      if (!opts?.resumeSessionId) return { text: "an answer" };
      // A --resume forks: the distill run reports its own id via agent-init.
      (opts.onEvent as (e: CodingEvent) => void)({ kind: "agent-init", sessionId: "sess-b" });
      return { text: DRAFT_JSON };
    });
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "shape it");
    updateComposerDraft(
      REPO,
      chatId,
      { issues: [{ title: "mine", body: "", acceptanceCriteria: [], labels: [] }], relations: [] },
      { 0: ["title"] },
    );

    const res = await generateComposerDraft(REPO, chatId);
    expect(res.ok).toBe(true);
    expect((res as { draft: ComposerDraft }).draft.issues).toHaveLength(2);
    const chat = getComposerChat(REPO, chatId);
    expect(chat?.draft?.issues[0].title).toBe("web:feat: a thing");
    expect(chat?.editedFlags).toBeUndefined();
    // The distill run's session is adopted as the chat's lineage.
    const next = provider.agent.mock.calls.length;
    await sendComposerChatMessage(REPO, chatId, "and now?");
    expect((provider.agent.mock.calls[next][1] as Record<string, unknown>).resumeSessionId).toBe(
      "sess-b",
    );
  });

  it("emits its own turn detail", async () => {
    const provider = fakeProvider(async (_p, opts) =>
      opts?.resumeSessionId ? { text: DRAFT_JSON } : { text: "an answer", sessionId: "sess-a" },
    );
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "shape it");
    h.events.length = 0;

    await generateComposerDraft(REPO, chatId);
    expect(h.events[0].event).toEqual({
      kind: "status",
      phase: "resuming",
      detail: CHAT_TURN_DETAILS.composerDraft,
    });
  });

  it("shares the send path's busy slot", async () => {
    const gate = deferred<LLMResponse>();
    let call = 0;
    const provider = fakeProvider(() => {
      call++;
      return call === 1 ? Promise.resolve({ text: "an answer", sessionId: "sess-a" }) : gate.promise;
    });
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "shape it");

    const distilling = generateComposerDraft(REPO, chatId);
    expect(await sendComposerChatMessage(REPO, chatId, "meanwhile")).toEqual({
      ok: false,
      error: "chat turn already running",
    });
    gate.resolve({ text: DRAFT_JSON });
    await distilling;
  });
});

describe("disposeComposerChat", () => {
  it("drops the record", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    disposeComposerChat(REPO, chatId);
    expect(getComposerChat(REPO, chatId)).toBeNull();
  });

  // A saved draft outlives the view that made it — that is the whole point.
  it("leaves a promoted chat's file on disk", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "keep me");
    await saveComposerDraft(REPO, chatId);

    disposeComposerChat(REPO, chatId);
    expect(getComposerChat(REPO, chatId)).toBeNull();
    expect(await readComposerDraftFile(draftsDir, chatId)).not.toBeNull();
  });
});

describe("saveComposerDraft", () => {
  it("projects the record onto disk, session lineage included", async () => {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "rate-limit the webhook");

    const res = await saveComposerDraft(REPO, chatId);
    expect(res).toEqual({ ok: true, draftId: chatId });

    const stored = await readComposerDraftFile(draftsDir, chatId);
    const minted = (provider.agent.mock.calls[0][1] as Record<string, unknown>).sessionId;
    expect(stored).toMatchObject({
      version: 1,
      draftId: chatId,
      chatId,
      repo: REPO,
      sessionId: minted,
      sessionRuntime: "claude-cli",
    });
    expect(stored?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual([
      "rate-limit the webhook",
      "an answer",
    ]);
    expect(h.draftChanges.count).toBe(1);
  });

  it("names the draft after the first drafted issue", async () => {
    const provider = fakeProvider(async (_p, opts) =>
      opts?.resumeSessionId ? { text: DRAFT_JSON } : { text: "an answer", sessionId: "sess-a" },
    );
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "shape it");
    await generateComposerDraft(REPO, chatId);

    await saveComposerDraft(REPO, chatId);
    expect((await readComposerDraftFile(draftsDir, chatId))?.title).toBe("web:feat: a thing");
  });

  it("falls back to the first line of the opening message", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "rate-limit the webhook\nand log the drops");

    await saveComposerDraft(REPO, chatId);
    expect((await readComposerDraftFile(draftsDir, chatId))?.title).toBe("rate-limit the webhook");
  });

  it("leaves the title empty when there is nothing to name it by", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();

    await saveComposerDraft(REPO, chatId);
    expect((await readComposerDraftFile(draftsDir, chatId))?.title).toBe("");
  });

  it("re-saves the same draft instead of forking a second one", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "first");
    const first = await saveComposerDraft(REPO, chatId);
    const createdAt = (await readComposerDraftFile(draftsDir, chatId))?.createdAt;

    await sendComposerChatMessage(REPO, chatId, "second");
    const second = await saveComposerDraft(REPO, chatId);

    expect(second).toEqual(first);
    const stored = await readComposerDraftFile(draftsDir, chatId);
    expect(stored?.createdAt).toBe(createdAt);
    expect(stored?.messages).toHaveLength(4);
  });

  it("rejects an unknown chat", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    expect(await saveComposerDraft(REPO, "nope")).toEqual({
      ok: false,
      error: "unknown composer chat",
    });
  });
});

// Promotion arms the three commit points: from then on the file keeps up with
// the chat without the user asking again.
describe("composer draft autosave", () => {
  it("persists the transcript after a send", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "first");
    await saveComposerDraft(REPO, chatId);
    const before = (await readComposerDraftFile(draftsDir, chatId))!;

    await sendComposerChatMessage(REPO, chatId, "second");

    const after = await waitForDraft(chatId, (d) => d.messages.length === 4);
    expect(after.messages.filter(isPlanChatText).map((m) => m.text)).toEqual([
      "first",
      "an answer",
      "second",
      "an answer",
    ]);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt >= before.updatedAt).toBe(true);
    expect(h.draftChanges.count).toBeGreaterThan(1);
  });

  it("persists the distilled draft", async () => {
    const provider = fakeProvider(async (_p, opts) =>
      opts?.resumeSessionId ? { text: DRAFT_JSON } : { text: "an answer", sessionId: "sess-a" },
    );
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "shape it");
    await saveComposerDraft(REPO, chatId);

    await generateComposerDraft(REPO, chatId);

    const stored = await waitForDraft(chatId, (d) => d.draft !== undefined);
    expect(stored.draft?.issues).toHaveLength(2);
    expect(stored.title).toBe("web:feat: a thing");
  });

  it("persists a renderer draft edit", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "go");
    await saveComposerDraft(REPO, chatId);

    updateComposerDraft(
      REPO,
      chatId,
      { issues: [{ title: "my own title", body: "b", acceptanceCriteria: [], labels: [] }], relations: [] },
      { 0: ["title"] },
    );

    const stored = await waitForDraft(chatId, (d) => d.draft !== undefined);
    expect(stored.draft?.issues[0].title).toBe("my own title");
    expect(stored.editedFlags).toEqual({ 0: ["title"] });
  });

  it("writes nothing for a chat that was never promoted", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();

    await sendComposerChatMessage(REPO, chatId, "go");
    updateComposerDraft(REPO, chatId, { issues: [], relations: [] }, {});
    await settle();

    expect(await readComposerDraftFile(draftsDir, chatId)).toBeNull();
    expect(h.draftChanges.count).toBe(0);
  });

  it("stops writing once the chat is demoted", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "go");
    await saveComposerDraft(REPO, chatId);

    demoteComposerDraft(chatId);
    const changesAtDemotion = h.draftChanges.count;
    await sendComposerChatMessage(REPO, chatId, "again");
    await settle();

    expect((await readComposerDraftFile(draftsDir, chatId))?.messages).toHaveLength(2);
    expect(h.draftChanges.count).toBe(changesAtDemotion);
  });
});

describe("resumeComposerChat", () => {
  async function promoted(): Promise<{ h: Harness; chatId: string; provider: ReturnType<typeof fakeProvider> }> {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "rate-limit the webhook");
    updateComposerDraft(
      REPO,
      chatId,
      { issues: [{ title: "mine", body: "b", acceptanceCriteria: [], labels: [] }], relations: [] },
      { 0: ["title"] },
    );
    await saveComposerDraft(REPO, chatId);
    return { h, chatId, provider };
  }

  it("rehydrates the record a restart would have lost", async () => {
    const { chatId } = await promoted();
    // A fresh driver: the in-memory map is gone, only the file survives.
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    expect(getComposerChat(REPO, chatId)).toBeNull();

    const res = await resumeComposerChat(REPO, chatId);
    expect(res).toEqual({ ok: true, chatId });
    const chat = getComposerChat(REPO, chatId);
    expect(chat?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual([
      "rate-limit the webhook",
      "an answer",
    ]);
    expect(chat?.draft?.issues[0].title).toBe("mine");
    expect(chat?.editedFlags).toEqual({ 0: ["title"] });
  });

  it("emits the one fetching reset the stream needs", async () => {
    const { chatId } = await promoted();
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());

    await resumeComposerChat(REPO, chatId);
    expect(h.events).toEqual([
      {
        key: `acme/widgets:${chatId}`,
        event: { kind: "status", phase: "fetching", detail: "composer resume" },
      },
    ]);
  });

  it("resumes the stored CLI session on the next turn", async () => {
    const { chatId, provider: first } = await promoted();
    const minted = (first.agent.mock.calls[0][1] as Record<string, unknown>).sessionId;
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    await resumeComposerChat(REPO, chatId);

    await sendComposerChatMessage(REPO, chatId, "and now?");
    expect((provider.agent.mock.calls[0][1] as Record<string, unknown>).resumeSessionId).toBe(minted);
  });

  it("degrades to a fresh seeded run when the stored session belongs to another runtime", async () => {
    const { chatId } = await promoted();
    const stored = (await readComposerDraftFile(draftsDir, chatId))!;
    await saveComposerDraftFile(draftsDir, { ...stored, sessionRuntime: "codex-cli" });
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    await resumeComposerChat(REPO, chatId);

    await sendComposerChatMessage(REPO, chatId, "and now?");
    const opts = provider.agent.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.resumeSessionId).toBeUndefined();
    expect(provider.agent.mock.calls[0][0] as string).toContain("--- Conversation so far ---");
  });

  it("keeps autosaving the resumed chat", async () => {
    const { chatId } = await promoted();
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    await resumeComposerChat(REPO, chatId);

    await sendComposerChatMessage(REPO, chatId, "one more");
    const after = await waitForDraft(chatId, (d) => d.messages.length === 4);
    expect(after.messages.filter(isPlanChatText).map((m) => m.text).at(-2)).toBe("one more");
  });

  it("refuses an unknown draft", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    expect(await resumeComposerChat(REPO, "never-saved")).toEqual({
      ok: false,
      error: "unknown draft",
    });
  });

  it("refuses a repo that is not linked", async () => {
    const { chatId } = await promoted();
    const h = makeHarness({ getRepoPath: () => undefined });
    initComposerChat(h.deps, fakeProvider());
    expect(await resumeComposerChat(REPO, chatId)).toEqual({ ok: false, error: "repo not linked" });
  });
});
