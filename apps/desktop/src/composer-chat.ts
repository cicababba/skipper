import { randomUUID } from "node:crypto";
import {
  AgentAbortError,
  discussComposer,
  distillComposerDraft,
  type GraphifyContext,
  type LLMProviderInterface,
  type MemoryMcp,
} from "@skipper/core";
import {
  CHAT_TURN_DETAILS,
  isPlanChatText,
  repoKey,
  type AgentRuntimeId,
  type CodingEvent,
  type ComposerChatSnapshot,
  type ComposerDraft,
  type ComposerEditedFlags,
  type GenerateComposerDraftResult,
  type LlmSettings,
  type PlanChatMessage,
  type RepoRef,
  type ResolvedRepoOrchestratorSettings,
  type ResumeComposerChatResult,
  type SaveComposerDraftResult,
  type SendComposerChatResult,
  type StartComposerChatResult,
  type StoredComposerDraft,
} from "@skipper/shared";
import { readComposerDraftFile, saveComposerDraftFile } from "./composer-draft-store";
import { checkoutEscapeReason, newDirtyPaths } from "./worktrees";
import { buildLlm, injectedBundle, modelForRole, providerCacheKey, type LlmBundle } from "./llm-settings";

// Chat composer driver (#136): a repo-grounded chat that distills into a
// multi-issue draft. Keyed by (repo, chatId) rather than a TrackedItem — the
// composer runs before any issue exists. A chat starts ephemeral: records live
// in this module until dispose or quit, so the agent-chat "persist-before-run"
// becomes "record-before-run". Saving the draft (#138) promotes the record to a
// file under <userData>/drafts/, and from then on every commit point re-persists.
//
// The run's cwd is the user's own checkout, so there is no confinement to lean
// on (that is a worktree-only guarantee) — the dirty-checkout tripwire is what
// catches a turn that wrote anything.

export interface ComposerChatDeps {
  getRepoPath: (repo: RepoRef) => string | undefined;
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  getLlmSettings: () => Promise<LlmSettings>;
  /** Uncommitted paths in the checkout (git status --porcelain); null if git fails (#196). */
  checkoutDirtyPaths: (repoPath: string) => Promise<string[] | null>;
  /** Composer console stream, keyed `${repoKey}:${chatId}`. */
  emitEvent: (key: string, event: CodingEvent) => void;
  getMemoryMcp?: (repo: RepoRef) => MemoryMcp | undefined;
  getRepoInstructions: (repo: RepoRef) => Promise<string | undefined>;
  getGraphify: (repo: RepoRef) => Promise<GraphifyContext | undefined> | undefined;
  /** Saved drafts root (#138), <userData>/drafts. */
  draftsDir: string;
  /** A draft file appeared, changed or vanished — the renderer's list is stale. */
  onDraftsChanged: () => void;
}

interface ComposerChatRecord {
  repo: RepoRef;
  chatId: string;
  cwd: string;
  sessionId?: string;
  sessionRuntimeId?: AgentRuntimeId;
  messages: PlanChatMessage[];
  draft?: ComposerDraft;
  editedFlags?: ComposerEditedFlags;
  /** Set once the chat is promoted (#138); its presence is what arms autosave. */
  draftId?: string;
  createdAt?: string;
}

let deps: ComposerChatDeps | null = null;
let injected = false;
let injectedProvider: LLMProviderInterface | null = null;
const chats = new Map<string, ComposerChatRecord>();
const bundles = new Map<string, LlmBundle>();
const inFlight = new Map<string, AbortController>();

export function chatKey(repo: RepoRef, chatId: string): string {
  return `${repoKey(repo)}:${chatId}`;
}

export function initComposerChat(
  composerChatDeps: ComposerChatDeps,
  provider?: LLMProviderInterface,
): void {
  deps = composerChatDeps;
  injected = provider !== undefined;
  injectedProvider = provider ?? null;
  chats.clear();
  bundles.clear();
  inFlight.clear();
}

async function resolveBundle(roleModel: string, roleRuntime: AgentRuntimeId): Promise<LlmBundle> {
  if (injected && injectedProvider) return injectedBundle(injectedProvider, roleModel, roleRuntime);
  const settings = await deps!.getLlmSettings();
  const model = modelForRole(settings, roleModel);
  const key = providerCacheKey(settings, model, roleRuntime);
  let bundle = bundles.get(key);
  if (!bundle) {
    bundle = buildLlm(settings, roleModel, 5, roleRuntime);
    bundles.set(key, bundle);
  }
  return bundle;
}

/**
 * Open a composer chat on a linked repo. Synchronous by design: the renderer
 * navigates on the returned id. The `fetching` status it emits is the ONLY one
 * on this stream, which makes it the event buffer's reset trigger.
 */
export function startComposerChat(repo: RepoRef): StartComposerChatResult {
  if (!deps) return { ok: false, error: "composer not initialized" };
  const cwd = deps.getRepoPath(repo);
  if (!cwd) return { ok: false, error: "repo not linked" };
  const chatId = randomUUID();
  const key = chatKey(repo, chatId);
  chats.set(key, { repo, chatId, cwd, messages: [] });
  deps.emitEvent(key, { kind: "status", phase: "fetching", detail: "composer start" });
  return { ok: true, chatId };
}

export function getComposerChat(repo: RepoRef, chatId: string): ComposerChatSnapshot | null {
  const record = chats.get(chatKey(repo, chatId));
  if (!record) return null;
  return {
    messages: record.messages,
    ...(record.draft ? { draft: record.draft } : {}),
    ...(record.editedFlags ? { editedFlags: record.editedFlags } : {}),
  };
}

/** Adopt the renderer's edits. Synchronous record write — allowed while a send
 *  runs (the next prompt then carries them); the renderer blocks it mid-distill. */
export function updateComposerDraft(
  repo: RepoRef,
  chatId: string,
  draft: ComposerDraft,
  editedFlags: ComposerEditedFlags,
): { ok: boolean; error?: string } {
  const record = chats.get(chatKey(repo, chatId));
  if (!record) return { ok: false, error: "unknown composer chat" };
  record.draft = draft;
  record.editedFlags = editedFlags;
  autosave(record);
  return { ok: true };
}

export function cancelComposerChat(repo: RepoRef, chatId: string): void {
  inFlight.get(chatKey(repo, chatId))?.abort();
}

export function disposeComposerChat(repo: RepoRef, chatId: string): void {
  const key = chatKey(repo, chatId);
  inFlight.get(key)?.abort();
  chats.delete(key);
}

/** The draft's first issue names it; before a distillation the opening question
 *  does. A chat saved before either is titled by the renderer's fallback. */
function draftTitle(record: ComposerChatRecord): string {
  const issueTitle = record.draft?.issues[0]?.title?.trim();
  if (issueTitle) return issueTitle;
  const firstUser = record.messages.find((m) => isPlanChatText(m) && m.role === "user");
  const opening =
    firstUser && isPlanChatText(firstUser) ? firstUser.text.split("\n")[0]?.trim() : undefined;
  return opening ? opening.slice(0, 120) : "";
}

function storedFrom(record: ComposerChatRecord, draftId: string): StoredComposerDraft {
  const now = new Date().toISOString();
  return {
    version: 1,
    draftId,
    repo: record.repo,
    chatId: record.chatId,
    title: draftTitle(record),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.sessionRuntimeId ? { sessionRuntime: record.sessionRuntimeId } : {}),
    messages: record.messages,
    ...(record.draft ? { draft: record.draft } : {}),
    ...(record.editedFlags ? { editedFlags: record.editedFlags } : {}),
    createdAt: record.createdAt ?? now,
    updatedAt: now,
  };
}

/** Autosave for an already-promoted chat: fire-and-forget through the store's
 *  save queue, so a turn never waits on the disk write to return its reply. */
function autosave(record: ComposerChatRecord): void {
  if (!record.draftId || !deps) return;
  const d = deps;
  void saveComposerDraftFile(d.draftsDir, storedFrom(record, record.draftId))
    .then(() => d.onDraftsChanged())
    .catch(() => {
      /* a failed autosave leaves the previous file — the next commit point retries */
    });
}

/** Promote a live chat to a saved draft. Idempotent: a second call re-persists
 *  the same draft id rather than forking a second file. */
export async function saveComposerDraft(
  repo: RepoRef,
  chatId: string,
): Promise<SaveComposerDraftResult> {
  if (!deps) return { ok: false, error: "composer not initialized" };
  const record = chats.get(chatKey(repo, chatId));
  if (!record) return { ok: false, error: "unknown composer chat" };
  const draftId = record.draftId ?? chatId;
  const stored = storedFrom(record, draftId);
  try {
    await saveComposerDraftFile(deps.draftsDir, stored);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  record.draftId = draftId;
  record.createdAt = stored.createdAt;
  deps.onDraftsChanged();
  return { ok: true, draftId };
}

/**
 * Rehydrate a saved draft into a live chat. The record carries the session
 * lineage back, so the next turn resumes the CLI session when the runtime still
 * matches and degrades to a fresh, history-seeded run when it does not. Emits
 * the `fetching` status start does — it is the event buffer's reset trigger.
 */
export async function resumeComposerChat(
  repo: RepoRef,
  draftId: string,
): Promise<ResumeComposerChatResult> {
  if (!deps) return { ok: false, error: "composer not initialized" };
  const cwd = deps.getRepoPath(repo);
  if (!cwd) return { ok: false, error: "repo not linked" };
  const stored = await readComposerDraftFile(deps.draftsDir, draftId);
  if (!stored) return { ok: false, error: "unknown draft" };
  const key = chatKey(repo, stored.chatId);
  chats.set(key, {
    repo,
    chatId: stored.chatId,
    cwd,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    ...(stored.sessionRuntime ? { sessionRuntimeId: stored.sessionRuntime } : {}),
    messages: stored.messages,
    ...(stored.draft ? { draft: stored.draft } : {}),
    ...(stored.editedFlags ? { editedFlags: stored.editedFlags } : {}),
    draftId: stored.draftId,
    createdAt: stored.createdAt,
  });
  deps.emitEvent(key, { kind: "status", phase: "fetching", detail: "composer resume" });
  return { ok: true, chatId: stored.chatId };
}

/** Drop the draft link from whichever live chat holds it (#138): without this a
 *  deleted draft would be resurrected by the next autosave. */
export function demoteComposerDraft(draftId: string): void {
  for (const record of chats.values()) {
    if (record.draftId === draftId) delete record.draftId;
  }
}

interface RunContext {
  record: ComposerChatRecord;
  key: string;
  controller: AbortController;
  provider: LLMProviderInterface;
  runtime: LlmBundle["runtime"];
  cwd: string;
  repoPath: string;
  checkoutBefore: string[] | null;
  memory: MemoryMcp | undefined;
  repoInstructions: string | undefined;
  graphify: GraphifyContext | undefined;
  resumable: boolean;
  fallbackSessionId: string | undefined;
}

/** Everything both turns need: the bundle, the repo context, and the session
 *  lineage decision. The caller has already claimed the in-flight slot. */
async function prepareRun(record: ComposerChatRecord, controller: AbortController): Promise<RunContext> {
  const repoPath = deps!.getRepoPath(record.repo) ?? record.cwd;
  const checkoutBefore = await deps!.checkoutDirtyPaths(repoPath);
  const settings = deps!.getRepoSettings(record.repo);
  const { llm: provider, runtime } = await resolveBundle(
    settings.composerModel,
    settings.composerRuntime,
  );
  const memory = deps!.getMemoryMcp?.(record.repo);
  const repoInstructions = await deps!.getRepoInstructions(record.repo).catch(() => undefined);
  const graphify = await deps!.getGraphify(record.repo)?.catch(() => undefined);
  const resumable =
    !!runtime?.capabilities.resume &&
    !!record.sessionId &&
    (record.sessionRuntimeId ?? runtime.id) === runtime.id;
  const fallbackSessionId = runtime?.capabilities.resume ? randomUUID() : undefined;
  return {
    record,
    key: chatKey(record.repo, record.chatId),
    controller,
    provider,
    runtime,
    cwd: record.cwd,
    repoPath,
    checkoutBefore,
    memory,
    repoInstructions,
    graphify,
    resumable,
    fallbackSessionId,
  };
}

/** The confinement tripwire (#196) adapted to the composer: the run is NOT
 *  confined (its cwd is the user's checkout), so this is the only guard that a
 *  discuss/distill turn left the working tree alone. */
async function checkoutEscaped(ctx: RunContext): Promise<string | undefined> {
  if (ctx.checkoutBefore === null) return undefined;
  const after = await deps!.checkoutDirtyPaths(ctx.repoPath);
  if (after === null) return undefined;
  const escaped = newDirtyPaths(ctx.checkoutBefore, after);
  return escaped.length > 0 ? checkoutEscapeReason(escaped) : undefined;
}

export async function sendComposerChatMessage(
  repo: RepoRef,
  chatId: string,
  text: string,
): Promise<SendComposerChatResult> {
  if (!deps) return { ok: false, error: "composer not initialized" };
  const message = text.trim();
  if (!message) return { ok: false, error: "message is empty" };
  const key = chatKey(repo, chatId);
  if (inFlight.has(key)) return { ok: false, error: "chat turn already running" };
  const record = chats.get(key);
  if (!record) return { ok: false, error: "unknown composer chat" };

  // Claim the slot synchronously (before any await) so a concurrent send busy-guards.
  const controller = new AbortController();
  inFlight.set(key, controller);
  try {
    const ctx = await prepareRun(record, controller);

    deps.emitEvent(key, {
      kind: "status",
      phase: "resuming",
      detail: CHAT_TURN_DETAILS.composerChat,
    });

    // Drift capture: --resume forks and reports a NEW id via agent-init.
    let sessionToRecord: string | undefined = ctx.resumable
      ? record.sessionId
      : ctx.fallbackSessionId;
    let sawEvent = false;
    const onEvent = (event: CodingEvent) => {
      sawEvent = true;
      if (event.kind === "agent-init" && event.sessionId) sessionToRecord = event.sessionId;
      deps?.emitEvent(key, event);
    };

    const common = {
      message,
      llm: ctx.provider,
      ...(ctx.runtime ? { runtime: ctx.runtime } : {}),
      cwd: ctx.cwd,
      ...(ctx.repoInstructions ? { repoInstructions: ctx.repoInstructions } : {}),
      ...(ctx.graphify ? { graphify: ctx.graphify } : {}),
      ...(record.draft ? { draft: record.draft } : {}),
      ...(record.editedFlags ? { edited: record.editedFlags } : {}),
      onEvent,
      ...(ctx.memory ? { memory: ctx.memory } : {}),
      signal: controller.signal,
    };

    const runFresh = async () => {
      // Record-before-run: the minted id is the lineage even if the process dies
      // mid-turn, so a later turn resumes instead of re-exploring.
      if (ctx.fallbackSessionId) {
        record.sessionId = ctx.fallbackSessionId;
        record.sessionRuntimeId = ctx.runtime?.id;
        sessionToRecord = ctx.fallbackSessionId;
      }
      return discussComposer({
        ...common,
        context: { history: record.messages },
        ...(ctx.fallbackSessionId ? { sessionId: ctx.fallbackSessionId } : {}),
      });
    };

    let reply: { reply: string; sessionId?: string };
    try {
      reply = ctx.resumable
        ? await discussComposer({ ...common, resumeSessionId: record.sessionId! })
        : await runFresh();
    } catch (err) {
      // A dead --resume (session gone from disk) fails fast without events:
      // retry once as a fresh, fully-seeded run (coder.ts dead-resume idiom).
      if (!ctx.resumable || sawEvent || err instanceof AgentAbortError) throw err;
      reply = await runFresh();
    }

    const escaped = await checkoutEscaped(ctx);
    if (escaped) return { ok: false, error: escaped };

    // Cooperative cancel: an aborted turn (or a disposed chat) records nothing.
    if (controller.signal.aborted || !chats.has(key)) return { ok: false, cancelled: true };

    const at = new Date().toISOString();
    record.messages.push({ role: "user", text: message, at });
    record.messages.push({ role: "assistant", text: reply.reply, at: new Date().toISOString() });
    if (sessionToRecord) {
      record.sessionId = sessionToRecord;
      record.sessionRuntimeId = ctx.runtime?.id;
    }
    autosave(record);
    return { ok: true, reply: reply.reply };
  } catch (err) {
    if (err instanceof AgentAbortError) return { ok: false, cancelled: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Distill the discussion into the structured draft. Shares the send path's
 * in-flight slot (prepareCoderChatApply precedent) so a send and a distillation
 * can never overlap. On success the draft replaces the record's and the edit
 * flags are cleared — the regenerated fields are the agent's again.
 */
export async function generateComposerDraft(
  repo: RepoRef,
  chatId: string,
): Promise<GenerateComposerDraftResult> {
  if (!deps) return { ok: false, error: "composer not initialized" };
  const key = chatKey(repo, chatId);
  if (inFlight.has(key)) return { ok: false, error: "chat turn already running" };
  const record = chats.get(key);
  if (!record) return { ok: false, error: "unknown composer chat" };
  if (record.messages.length === 0) return { ok: false, error: "no discussion to distill" };

  const controller = new AbortController();
  inFlight.set(key, controller);
  try {
    const ctx = await prepareRun(record, controller);

    deps.emitEvent(key, {
      kind: "status",
      phase: "resuming",
      detail: CHAT_TURN_DETAILS.composerDraft,
    });

    let sessionToRecord: string | undefined = ctx.resumable
      ? record.sessionId
      : ctx.fallbackSessionId;
    let sawEvent = false;
    const onEvent = (event: CodingEvent) => {
      sawEvent = true;
      if (event.kind === "agent-init" && event.sessionId) sessionToRecord = event.sessionId;
      deps?.emitEvent(key, event);
    };

    const common = {
      llm: ctx.provider,
      ...(ctx.runtime ? { runtime: ctx.runtime } : {}),
      cwd: ctx.cwd,
      ...(ctx.repoInstructions ? { repoInstructions: ctx.repoInstructions } : {}),
      ...(ctx.graphify ? { graphify: ctx.graphify } : {}),
      ...(record.draft ? { draft: record.draft } : {}),
      ...(record.editedFlags ? { edited: record.editedFlags } : {}),
      onEvent,
      ...(ctx.memory ? { memory: ctx.memory } : {}),
      signal: controller.signal,
    };

    const runFresh = async () => {
      if (ctx.fallbackSessionId) {
        record.sessionId = ctx.fallbackSessionId;
        record.sessionRuntimeId = ctx.runtime?.id;
        sessionToRecord = ctx.fallbackSessionId;
      }
      return distillComposerDraft({
        ...common,
        context: { history: record.messages },
        ...(ctx.fallbackSessionId ? { sessionId: ctx.fallbackSessionId } : {}),
      });
    };

    let result: { draft: ComposerDraft; sessionId?: string };
    try {
      result = ctx.resumable
        ? await distillComposerDraft({ ...common, resumeSessionId: record.sessionId! })
        : await runFresh();
    } catch (err) {
      if (!ctx.resumable || sawEvent || err instanceof AgentAbortError) throw err;
      result = await runFresh();
    }

    const escaped = await checkoutEscaped(ctx);
    if (escaped) return { ok: false, error: escaped };

    if (controller.signal.aborted || !chats.has(key)) return { ok: false, cancelled: true };

    record.draft = result.draft;
    delete record.editedFlags;
    if (sessionToRecord) {
      record.sessionId = sessionToRecord;
      record.sessionRuntimeId = ctx.runtime?.id;
    }
    autosave(record);
    return { ok: true, draft: result.draft };
  } catch (err) {
    if (err instanceof AgentAbortError) return { ok: false, cancelled: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(key);
  }
}
