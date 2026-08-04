import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeId,
  CodingEvent,
  ComposerDraft,
  LlmSettings,
  PlanChatAttachment,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredComposerDraft,
} from "@skipper/shared";
import { CHAT_TURN_DETAILS, DEFAULT_LLM_SETTINGS, isPlanChatText } from "@skipper/shared";
import type { GraphifyContext, LLMProviderInterface, LLMResponse } from "@skipper/core";
import { ClaudeCliError } from "@skipper/core";
import { existsSync } from "node:fs";
import {
  attachComposerFile,
  cancelComposerChat,
  demoteComposerDraft,
  detachComposerFile,
  disposeComposerChat,
  flushUnfinishedComposerChats,
  generateComposerDraft,
  getComposerChat,
  hasLiveComposerChat,
  initComposerChat,
  resumeComposerChat,
  saveComposerDraft,
  sendComposerChatMessage,
  startComposerChat,
  updateComposerDraft,
  type ComposerChatDeps,
} from "./composer-chat";
import {
  deleteComposerDraftFile,
  draftFilePath,
  readComposerDraftFile,
  saveComposerDraftFile,
} from "./composer-draft-store";

const REPO: RepoRef = { owner: "acme", name: "widgets" };
const OTHER_REPO: RepoRef = { owner: "acme", name: "rocket" };

let draftsDir: string;
let attachmentsDir: string;

beforeEach(async () => {
  draftsDir = await mkdtemp(join(tmpdir(), "sk-composer-drafts-"));
  attachmentsDir = await mkdtemp(join(tmpdir(), "sk-composer-attachments-"));
});

afterEach(async () => {
  await rm(draftsDir, { recursive: true, force: true });
  await rm(attachmentsDir, { recursive: true, force: true });
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
    attachmentsDir,
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

function start(repo: RepoRef = REPO): string {
  const res = startComposerChat(repo);
  if (!res.ok) throw new Error(res.error);
  return res.chatId;
}

const QUICK_DRAFT: ComposerDraft = {
  issues: [{ title: "web:fix: the topbar jumps", body: "", acceptanceCriteria: [], labels: [] }],
  relations: [],
};

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

  it("keeps the turn when core salvages a max-turns death (#301)", async () => {
    const provider = fakeProvider(async (_prompt, opts) => {
      if (opts?.resumeSessionId) return { text: "a partial answer" };
      throw new ClaudeCliError("agent hit the max-turns limit after 61 turns", "error_max_turns", 61);
    });
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();

    const res = await sendComposerChatMessage(REPO, chatId, "how does the orchestrator work?");
    expect(res).toEqual({ ok: true, reply: "a partial answer" });
    expect(provider.agent).toHaveBeenCalledTimes(2);
    // The wrap-up resumes the id the driver minted and recorded before the run.
    const minted = (provider.agent.mock.calls[0][1] as Record<string, unknown>).sessionId;
    expect((provider.agent.mock.calls[1][1] as Record<string, unknown>).resumeSessionId).toBe(minted);
    expect(getComposerChat(REPO, chatId)?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual([
      "how does the orchestrator work?",
      "a partial answer",
    ]);
  });

  it("reports a turn-limit kind and persists nothing when the salvage dies too", async () => {
    const provider = fakeProvider(async () => {
      throw new ClaudeCliError("agent hit the max-turns limit after 61 turns", "error_max_turns", 61);
    });
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();

    const res = await sendComposerChatMessage(REPO, chatId, "how does the orchestrator work?");
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("max-turns limit"),
      errorKind: "turn-limit",
    });
    expect(getComposerChat(REPO, chatId)?.messages).toEqual([]);
  });

  it("reports a timeout kind for a hard-timeout death", async () => {
    const provider = fakeProvider(async () => {
      throw new ClaudeCliError("agent run hit the time budget (8 min) — killed", "error_hard_timeout");
    });
    const h = makeHarness();
    initComposerChat(h.deps, provider);
    const chatId = start();

    const res = await sendComposerChatMessage(REPO, chatId, "how does the orchestrator work?");
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("time budget"),
      errorKind: "timeout",
    });
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
    await disposeComposerChat(REPO, chatId);
    expect(getComposerChat(REPO, chatId)).toBeNull();
  });

  // A saved draft outlives the view that made it — that is the whole point.
  it("leaves a promoted chat's file on disk", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "keep me");
    await saveComposerDraft(REPO, chatId);

    await disposeComposerChat(REPO, chatId);
    expect(getComposerChat(REPO, chatId)).toBeNull();
    expect(await readComposerDraftFile(draftsDir, chatId)).not.toBeNull();
  });
});

// Abandonment (#272): leaving the composer auto-saves the session as an
// unfinished draft, at most one per repo, until an explicit save or a publish
// takes it out of the pool.
describe("unfinished capture", () => {
  async function abandoned(repo: RepoRef = REPO, text = "rate-limit the webhook"): Promise<string> {
    const chatId = start(repo);
    await sendComposerChatMessage(repo, chatId, text);
    await disposeComposerChat(repo, chatId);
    return chatId;
  }

  it("writes the abandoned chat as an unfinished draft and pings the list", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "rate-limit the webhook");

    await disposeComposerChat(REPO, chatId);

    const stored = await readComposerDraftFile(draftsDir, chatId);
    expect(stored).toMatchObject({
      version: 1,
      draftId: chatId,
      chatId,
      repo: REPO,
      unfinished: true,
      title: "rate-limit the webhook",
    });
    expect(stored?.messages.filter(isPlanChatText).map((m) => m.text)).toEqual([
      "rate-limit the webhook",
      "an answer",
    ]);
    expect(h.draftChanges.count).toBe(1);
    expect(getComposerChat(REPO, chatId)).toBeNull();
  });

  // The quick path (#137) never discusses anything: its content is the card.
  it("captures a quick-shaped session that only ever had card content", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    updateComposerDraft(REPO, chatId, QUICK_DRAFT, {});

    await disposeComposerChat(REPO, chatId);

    const stored = await readComposerDraftFile(draftsDir, chatId);
    expect(stored?.unfinished).toBe(true);
    expect(stored?.messages).toEqual([]);
    expect(stored?.title).toBe("web:fix: the topbar jumps");
  });

  it("writes nothing for a session that holds no content", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const empty = start();
    const blank = start();
    updateComposerDraft(
      REPO,
      blank,
      { issues: [{ title: "  ", body: "\n", acceptanceCriteria: [], labels: [] }], relations: [] },
      {},
    );

    await disposeComposerChat(REPO, empty);
    await disposeComposerChat(REPO, blank);
    await settle();

    expect(await readComposerDraftFile(draftsDir, empty)).toBeNull();
    expect(await readComposerDraftFile(draftsDir, blank)).toBeNull();
    expect(h.draftChanges.count).toBe(0);
  });

  it("writes nothing when the renderer says the content was discarded", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "published already");

    await disposeComposerChat(REPO, chatId, { discard: true });
    await settle();

    expect(await readComposerDraftFile(draftsDir, chatId)).toBeNull();
    expect(h.draftChanges.count).toBe(0);
  });

  it("keeps one unfinished draft per repo and never touches the explicit ones", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    // An explicit draft in the same repo: saved on purpose, off the pool.
    const explicit = start();
    await sendComposerChatMessage(REPO, explicit, "keep me on purpose");
    await saveComposerDraft(REPO, explicit);
    await disposeComposerChat(REPO, explicit);
    const other = await abandoned(OTHER_REPO, "another repo entirely");

    const first = await abandoned(REPO, "one");
    const second = await abandoned(REPO, "two");

    expect(await readComposerDraftFile(draftsDir, first)).toBeNull();
    expect((await readComposerDraftFile(draftsDir, second))?.unfinished).toBe(true);
    expect((await readComposerDraftFile(draftsDir, explicit))?.unfinished).toBeUndefined();
    expect((await readComposerDraftFile(draftsDir, other))?.unfinished).toBe(true);
  });

  // A resumed session autosaves into its own file: the sweep must not delete the
  // draft another live mount is still writing.
  it("spares the unfinished draft a live record still holds", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const resumed = await abandoned(REPO, "one");
    await resumeComposerChat(REPO, resumed);

    const second = await abandoned(REPO, "two");

    expect(await readComposerDraftFile(draftsDir, resumed)).not.toBeNull();
    expect(await readComposerDraftFile(draftsDir, second)).not.toBeNull();
  });

  it("reports the flag on resume and keeps it through the autosaves", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = await abandoned();

    expect(await resumeComposerChat(REPO, chatId)).toEqual({ ok: true, chatId, unfinished: true });

    await sendComposerChatMessage(REPO, chatId, "one more");
    const after = await waitForDraft(chatId, (d) => d.messages.length === 4);
    expect(after.unfinished).toBe(true);
  });

  it("clears the flag on an explicit save and takes the draft off the pool", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = await abandoned();
    await resumeComposerChat(REPO, chatId);

    expect(await saveComposerDraft(REPO, chatId)).toEqual({ ok: true, draftId: chatId });
    expect((await readComposerDraftFile(draftsDir, chatId))?.unfinished).toBeUndefined();

    // Promoted now, so its own dispose captures nothing and the next abandoned
    // session in the repo has no claim on it either.
    await disposeComposerChat(REPO, chatId);
    const later = await abandoned(REPO, "a later session");

    expect(await readComposerDraftFile(draftsDir, chatId)).not.toBeNull();
    expect((await readComposerDraftFile(draftsDir, later))?.unfinished).toBe(true);
  });

  // The publish path deletes the file and demotes the record; the dispose that
  // follows must not bring it back.
  it("captures nothing once the draft was demoted", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "published already");
    await saveComposerDraft(REPO, chatId);

    demoteComposerDraft(chatId);
    await deleteComposerDraftFile(draftsDir, chatId);
    await disposeComposerChat(REPO, chatId);
    await settle();

    expect(await readComposerDraftFile(draftsDir, chatId)).toBeNull();
  });
});

// Quit (#272): dispose never runs, so the sweep is the last chance — and it has
// to finish before the process goes, hence synchronous.
describe("flushUnfinishedComposerChats", () => {
  it("writes the eligible records synchronously and skips the rest", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const contentful = start();
    await sendComposerChatMessage(REPO, contentful, "still typing when it quit");
    const empty = start(OTHER_REPO);
    const promoted = start(OTHER_REPO);
    await sendComposerChatMessage(OTHER_REPO, promoted, "already saved");
    await saveComposerDraft(OTHER_REPO, promoted);
    const changesBefore = h.draftChanges.count;

    flushUnfinishedComposerChats();

    // Sync write: the file is there before anything is awaited.
    expect(existsSync(draftFilePath(draftsDir, contentful))).toBe(true);
    expect((await readComposerDraftFile(draftsDir, contentful))?.unfinished).toBe(true);
    expect(await readComposerDraftFile(draftsDir, empty)).toBeNull();
    expect((await readComposerDraftFile(draftsDir, promoted))?.unfinished).toBeUndefined();
    // The renderer is going away with the process: no broadcast to make.
    expect(h.draftChanges.count).toBe(changesBefore);
  });

  it("leaves a discarded record alone", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "published already");
    await saveComposerDraft(REPO, chatId);
    demoteComposerDraft(chatId);
    await deleteComposerDraftFile(draftsDir, chatId);

    flushUnfinishedComposerChats();

    expect(await readComposerDraftFile(draftsDir, chatId)).toBeNull();
  });

  it("still ends up with one unfinished draft per repo", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const stale = await (async () => {
      const id = start();
      await sendComposerChatMessage(REPO, id, "abandoned earlier");
      await disposeComposerChat(REPO, id);
      return id;
    })();
    const live = start();
    await sendComposerChatMessage(REPO, live, "live at quit");

    flushUnfinishedComposerChats();

    expect(await readComposerDraftFile(draftsDir, stale)).toBeNull();
    expect((await readComposerDraftFile(draftsDir, live))?.unfinished).toBe(true);
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
    await waitForDraft(chatId, (d) => d.messages.length === 4);
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
    await waitForDraft(chatId, (d) => d.messages.length === 4);
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

// Attachments (#281): saved under <userData>, referenced by absolute path in the
// turn prompt, and cleaned up along whichever path ends the chat's life.
describe("attachComposerFile", () => {
  const png = () => new Uint8Array(Buffer.from("png-bytes"));

  function withRuntime(runtime: AgentRuntimeId): Harness {
    return makeHarness({
      getRepoSettings: () =>
        ({ composerModel: "opus", composerRuntime: runtime }) as unknown as ResolvedRepoOrchestratorSettings,
    });
  }

  it("writes the file under the chat's own directory", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();

    const res = await attachComposerFile(REPO, chatId, "shot.png", png());

    expect(res).toEqual({
      ok: true,
      path: join(attachmentsDir, chatId, "shot.png"),
      name: "shot.png",
      supported: true,
    });
    expect(await readFile(join(attachmentsDir, chatId, "shot.png"), "utf-8")).toBe("png-bytes");
  });

  it("refuses a chat that is not live", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    expect(await attachComposerFile(REPO, "never-started", "shot.png", png())).toEqual({
      ok: false,
      error: "unknown composer chat",
    });
  });

  it("reports the store's rejection instead of throwing", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    const res = await attachComposerFile(REPO, chatId, "payload.docx", png());
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/Unsupported attachment type/);
  });

  // The warning is computed at attach time from the repo's effective composer
  // runtime — no capability IPC of its own.
  it.each([
    ["claude-cli", true, true],
    ["codex-cli", true, false],
    ["gemini-cli", true, true],
    ["copilot-cli", false, false],
  ] as const)("reports supported per %s × kind", async (runtime, image, pdf) => {
    const h = withRuntime(runtime);
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();

    const shot = await attachComposerFile(REPO, chatId, "shot.png", png());
    const spec = await attachComposerFile(REPO, chatId, "spec.pdf", png());
    const notes = await attachComposerFile(REPO, chatId, "notes.md", png());

    expect(shot).toMatchObject({ ok: true, supported: image });
    expect(spec).toMatchObject({ ok: true, supported: pdf });
    // Text always works: every CLI has a plain file reader.
    expect(notes).toMatchObject({ ok: true, supported: true });
  });
});

describe("detachComposerFile", () => {
  it("removes a file the user took back before sending", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    const saved = (await attachComposerFile(
      REPO,
      chatId,
      "shot.png",
      new Uint8Array([1]),
    )) as { path: string };

    expect(await detachComposerFile(REPO, chatId, saved.path)).toEqual({ ok: true });
    expect(existsSync(saved.path)).toBe(false);
  });

  it("refuses a path outside the chat's directory", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    const other = start();
    const saved = (await attachComposerFile(
      REPO,
      other,
      "shot.png",
      new Uint8Array([1]),
    )) as { path: string };

    const res = await detachComposerFile(REPO, chatId, saved.path);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside its chat directory/);
    expect(existsSync(saved.path)).toBe(true);
  });
});

describe("sendComposerChatMessage with attachments", () => {
  async function attach(chatId: string, name: string): Promise<PlanChatAttachment> {
    const res = await attachComposerFile(REPO, chatId, name, new Uint8Array(Buffer.from("data")));
    if (!res.ok) throw new Error(res.error);
    return { name: res.name, path: res.path };
  }

  it("threads the paths into the prompt and records them on the user turn", async () => {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();
    const shot = await attach(chatId, "shot.png");
    const spec = await attach(chatId, "spec.pdf");

    const res = await sendComposerChatMessage(REPO, chatId, "why is the header cut off?", [
      shot,
      spec,
    ]);

    expect(res).toMatchObject({ ok: true });
    const prompt = provider.agent.mock.calls[0][0] as string;
    expect(prompt).toContain(`Attached image: ${shot.path} — read this file before answering.`);
    expect(prompt).toContain(`Attached PDF: ${spec.path} — read this file before answering.`);
    const user = getComposerChat(REPO, chatId)?.messages.filter(isPlanChatText)[0];
    expect(user?.attachments).toEqual([shot, spec]);
  });

  it("says nothing about attachments on a turn without any", async () => {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();

    await sendComposerChatMessage(REPO, chatId, "plain question");

    expect(provider.agent.mock.calls[0][0] as string).not.toContain("Attached");
    expect(getComposerChat(REPO, chatId)?.messages.filter(isPlanChatText)[0].attachments).toBeUndefined();
  });

  it("persists the attachments into the saved draft", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    const shot = await attach(chatId, "shot.png");
    await sendComposerChatMessage(REPO, chatId, "look at this", [shot]);

    await saveComposerDraft(REPO, chatId);

    const stored = await readComposerDraftFile(draftsDir, chatId);
    expect(stored?.messages.filter(isPlanChatText)[0].attachments).toEqual([shot]);
  });

  // The renderer's paths cross IPC and end up in a prompt telling the agent to
  // read them, so the driver re-validates rather than trusting them.
  it("refuses a path outside the chat's directory and runs nothing", async () => {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();

    const res = await sendComposerChatMessage(REPO, chatId, "read this", [
      { name: "passwd", path: "/etc/passwd" },
    ]);

    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/outside its chat directory/);
    expect(provider.agent).not.toHaveBeenCalled();
  });

  it("refuses an attachment that is no longer on disk", async () => {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();
    const shot = await attach(chatId, "shot.png");
    await detachComposerFile(REPO, chatId, shot.path);

    const res = await sendComposerChatMessage(REPO, chatId, "read this", [shot]);

    expect(res.ok).toBe(false);
    expect(provider.agent).not.toHaveBeenCalled();
  });

  it("refuses more than four attachments", async () => {
    const h = makeHarness();
    const provider = fakeProvider();
    initComposerChat(h.deps, provider);
    const chatId = start();
    const five = [];
    for (let i = 0; i < 5; i++) five.push(await attach(chatId, `shot-${i}.png`));

    const res = await sendComposerChatMessage(REPO, chatId, "read these", five);

    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/At most 4 attachments/);
    expect(provider.agent).not.toHaveBeenCalled();
    // Four is still fine.
    await expect(
      sendComposerChatMessage(REPO, chatId, "read these", five.slice(0, 4)),
    ).resolves.toMatchObject({ ok: true });
  });
});

// Attachments outlive the record exactly as long as a draft can resume them.
describe("attachment cleanup matrix (#281)", () => {
  const dirOf = (chatId: string) => join(attachmentsDir, chatId);

  async function withAttachment(chatId: string, repo: RepoRef = REPO): Promise<void> {
    const res = await attachComposerFile(repo, chatId, "shot.png", new Uint8Array([1]));
    if (!res.ok) throw new Error(res.error);
  }

  it("deletes the directory when the renderer discards the chat", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "published already");
    await withAttachment(chatId);

    await disposeComposerChat(REPO, chatId, { discard: true });

    expect(existsSync(dirOf(chatId))).toBe(false);
  });

  it("keeps the directory when the chat was promoted to a saved draft", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "keep me");
    await withAttachment(chatId);
    await saveComposerDraft(REPO, chatId);

    await disposeComposerChat(REPO, chatId);

    expect(existsSync(dirOf(chatId))).toBe(true);
  });

  it("keeps the directory behind an auto-saved unfinished draft", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await sendComposerChatMessage(REPO, chatId, "abandoned mid-discussion");
    await withAttachment(chatId);

    await disposeComposerChat(REPO, chatId);
    await settle();

    expect((await readComposerDraftFile(draftsDir, chatId))?.unfinished).toBe(true);
    expect(existsSync(dirOf(chatId))).toBe(true);
  });

  it("deletes the directory of an attach-then-abandon session with no content", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    await withAttachment(chatId);

    await disposeComposerChat(REPO, chatId);
    await settle();

    expect(await readComposerDraftFile(draftsDir, chatId)).toBeNull();
    expect(existsSync(dirOf(chatId))).toBe(false);
  });

  it("takes the attachments along when the unfinished sweep drops a draft", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const first = start();
    await sendComposerChatMessage(REPO, first, "one");
    await withAttachment(first);
    await disposeComposerChat(REPO, first);
    await settle();
    expect(existsSync(dirOf(first))).toBe(true);

    // A second abandoned session in the same repo overwrites the pool entry.
    const second = start();
    await sendComposerChatMessage(REPO, second, "two");
    await withAttachment(second);
    await disposeComposerChat(REPO, second);
    await settle();

    expect(await readComposerDraftFile(draftsDir, first)).toBeNull();
    expect(existsSync(dirOf(first))).toBe(false);
    expect(existsSync(dirOf(second))).toBe(true);
  });

  it("deletes the ineligible records' directories synchronously at quit", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const contentful = start();
    await sendComposerChatMessage(REPO, contentful, "still typing when it quit");
    await withAttachment(contentful);
    const empty = start(OTHER_REPO);
    await withAttachment(empty, OTHER_REPO);

    flushUnfinishedComposerChats();

    // Sync: both verdicts are settled before anything is awaited.
    expect(existsSync(dirOf(empty))).toBe(false);
    expect(existsSync(dirOf(contentful))).toBe(true);
  });

  // The sweep's directory listing can land after a chat was started (a busy fs
  // threadpool is enough), which is why the live check runs at delete time. The
  // gated listing reproduces that interleaving instead of racing for it (#316).
  it("keeps a live chat's directory when the init sweep listed it (#316)", async () => {
    const gate = deferred<void>();
    vi.resetModules();
    vi.doMock("./composer-attachment-store", async () => {
      const actual =
        await vi.importActual<typeof import("./composer-attachment-store")>("./composer-attachment-store");
      return {
        ...actual,
        listAttachmentDirs: async (root: string) => {
          await gate.promise;
          return actual.listAttachmentDirs(root);
        },
      };
    });
    try {
      const mod = await import("./composer-chat");
      const swept = mod.initComposerChat(makeHarness().deps, fakeProvider());
      const started = mod.startComposerChat(REPO);
      if (!started.ok) throw new Error(started.error);
      const attached = await mod.attachComposerFile(REPO, started.chatId, "shot.png", new Uint8Array([1]));
      if (!attached.ok) throw new Error(attached.error);
      gate.resolve();
      await swept;

      expect(existsSync(dirOf(started.chatId))).toBe(true);
    } finally {
      vi.doUnmock("./composer-attachment-store");
      vi.resetModules();
    }
  });

  it("keeps only the surviving capture's directory when two compete at quit", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const displaced = start();
    await sendComposerChatMessage(REPO, displaced, "older session");
    await withAttachment(displaced);
    const winner = start();
    await sendComposerChatMessage(REPO, winner, "newer session");
    await withAttachment(winner);

    flushUnfinishedComposerChats();

    expect(existsSync(dirOf(displaced))).toBe(false);
    expect(existsSync(dirOf(winner))).toBe(true);
  });
});

describe("hasLiveComposerChat", () => {
  it("tracks the record's lifetime, so the drafts-delete handler can defer", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const chatId = start();
    expect(hasLiveComposerChat(chatId)).toBe(true);

    await disposeComposerChat(REPO, chatId, { discard: true });

    expect(hasLiveComposerChat(chatId)).toBe(false);
  });
});

// Nothing is live at init, so a directory with no draft behind it belongs to a
// session that ended without cleanup.
describe("orphan attachment sweep at init", () => {
  it("removes the directories no stored draft claims", async () => {
    const h = makeHarness();
    initComposerChat(h.deps, fakeProvider());
    const kept = start();
    await sendComposerChatMessage(REPO, kept, "keep me");
    const res = await attachComposerFile(REPO, kept, "shot.png", new Uint8Array([1]));
    if (!res.ok) throw new Error(res.error);
    await saveComposerDraft(REPO, kept);

    // A leftover from a session that never got to clean up after itself.
    await mkdir(join(attachmentsDir, "orphan-chat"), { recursive: true });
    await writeFile(join(attachmentsDir, "orphan-chat", "stray.png"), "x");

    await initComposerChat(makeHarness().deps, fakeProvider());

    expect(existsSync(join(attachmentsDir, "orphan-chat"))).toBe(false);
    expect(existsSync(join(attachmentsDir, kept))).toBe(true);
  });
});
