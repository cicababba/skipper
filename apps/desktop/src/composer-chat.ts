import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import {
  AgentAbortError,
  discussComposer,
  distillComposerDraft,
  RUNTIME_CAPABILITIES,
  type GraphifyContext,
  type LLMProviderInterface,
  type MemoryMcp,
} from "@skipper/core";
import {
  CHAT_TURN_DETAILS,
  isPlanChatText,
  repoKey,
  type AgentRuntimeId,
  type AttachComposerFileResult,
  type CodingEvent,
  type ComposerChatSnapshot,
  type ComposerDraft,
  type ComposerEditedFlags,
  type GenerateComposerDraftResult,
  type LlmSettings,
  type PlanChatAttachment,
  type PlanChatMessage,
  type RepoRef,
  type ResolvedRepoOrchestratorSettings,
  type ResumeComposerChatResult,
  type SaveComposerDraftResult,
  type SendComposerChatResult,
  type StartComposerChatResult,
  type StoredComposerDraft,
} from "@skipper/shared";
import {
  deleteUnfinishedDraftFiles,
  deleteUnfinishedDraftFilesSync,
  listComposerDraftChatIds,
  readComposerDraftFile,
  saveComposerDraftFile,
  saveComposerDraftFileSync,
} from "./composer-draft-store";
import {
  assertAttachmentPath,
  attachmentDir,
  attachmentKind,
  deleteAttachmentFile,
  deleteAttachmentsDir,
  deleteAttachmentsDirSync,
  listAttachmentDirs,
  saveAttachmentFile,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./composer-attachment-store";
import { checkoutEscapeReason, newDirtyPaths } from "./worktrees";
import { chatErrorKind } from "./chat-error";
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
  /** Chat attachments root (#281), <userData>/composer/attachments. */
  attachmentsDir: string;
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
  /** The draft behind this record was auto-saved on abandonment (#272), not
   *  saved on purpose — an explicit save is what clears it. */
  unfinished?: boolean;
  /** The content is deliberately gone (published, or a confirmed mode switch):
   *  dispose must not resurrect it as an unfinished draft (#272). */
  discarded?: boolean;
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

/** Returns the orphan sweep so a caller that cares about its outcome can await
 *  it; it swallows its own errors, so ignoring the promise is safe. */
export function initComposerChat(
  composerChatDeps: ComposerChatDeps,
  provider?: LLMProviderInterface,
): Promise<void> {
  deps = composerChatDeps;
  injected = provider !== undefined;
  injectedProvider = provider ?? null;
  chats.clear();
  bundles.clear();
  inFlight.clear();
  return sweepOrphanAttachments(composerChatDeps);
}

/** Sanitized attachment directory names of every chat a record still holds. */
function liveAttachmentDirs(root: string): Set<string> {
  const live = new Set<string>();
  for (const record of chats.values()) live.add(basename(attachmentDir(root, record.chatId)));
  return live;
}

/** Nothing is live at init, so an attachment directory with no draft behind it
 *  belongs to a session that ended without cleanup (#281). Best-effort. */
async function sweepOrphanAttachments(d: ComposerChatDeps): Promise<void> {
  try {
    const dirs = await listAttachmentDirs(d.attachmentsDir);
    if (dirs.length === 0) return;
    const chatIds = await listComposerDraftChatIds(d.draftsDir);
    const keep = new Set(chatIds.map((id) => basename(attachmentDir(d.attachmentsDir, id))));
    for (const dir of dirs) {
      if (keep.has(dir)) continue;
      // Re-read the live records at delete time, not at listing time: a chat
      // started while the sweep was awaiting owns its directory (#316).
      if (liveAttachmentDirs(d.attachmentsDir).has(dir)) continue;
      await deleteAttachmentsDir(d.attachmentsDir, dir);
    }
  } catch {
    /* an orphan that survives costs disk, nothing else — the next init retries */
  }
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

/** Does a live record still hold this chat? The drafts-delete handler asks
 *  before removing an attachment directory dispose is about to handle (#281). */
export function hasLiveComposerChat(chatId: string): boolean {
  for (const record of chats.values()) if (record.chatId === chatId) return true;
  return false;
}

/** Can the repo's effective composer runtime read this kind of file? Text always
 *  works — every CLI has a plain file reader. */
function attachmentSupported(repo: RepoRef, kind: ReturnType<typeof attachmentKind>): boolean {
  if (kind === null || kind === "text") return true;
  const runtimeId = deps!.getRepoSettings(repo).composerRuntime;
  const caps = RUNTIME_CAPABILITIES[runtimeId];
  return kind === "image" ? caps.images : caps.pdfs;
}

/**
 * Persist a pasted/dropped file for a live chat (#281). The bytes land under
 * <userData>, never in the checkout the turn runs in — the dirty-tree tripwire
 * would fail the turn otherwise.
 */
export async function attachComposerFile(
  repo: RepoRef,
  chatId: string,
  name: string,
  bytes: Uint8Array,
): Promise<AttachComposerFileResult> {
  if (!deps) return { ok: false, error: "composer not initialized" };
  if (!chats.has(chatKey(repo, chatId))) return { ok: false, error: "unknown composer chat" };
  try {
    const saved = await saveAttachmentFile(deps.attachmentsDir, chatId, name, bytes);
    return {
      ok: true,
      path: saved.path,
      name: saved.name,
      supported: attachmentSupported(repo, saved.kind),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Drop an attachment the user removed before sending. */
export async function detachComposerFile(
  repo: RepoRef,
  chatId: string,
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps) return { ok: false, error: "composer not initialized" };
  try {
    const abs = assertAttachmentPath(deps.attachmentsDir, chatId, path);
    await deleteAttachmentFile(abs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Worth keeping when the user walks away: a discussion, or hand-written issue
 *  content in a draft that was never distilled from one. */
function hasCaptureContent(record: ComposerChatRecord): boolean {
  if (record.messages.length > 0) return true;
  return record.draft?.issues.some((i) => i.title.trim() !== "" || i.body.trim() !== "") ?? false;
}

/** Drafts no unfinished sweep may delete: the capture just written plus every
 *  draft a live record still autosaves into. */
function unfinishedKeepIds(capturedId: string): Set<string> {
  const keep = new Set<string>([capturedId]);
  for (const record of chats.values()) if (record.draftId) keep.add(record.draftId);
  return keep;
}

/**
 * Drop the chat record. An unpromoted session with content is auto-saved as an
 * unfinished draft first (#272) so leaving the composer stops losing work;
 * `discard` (publish, confirmed mode switch) says the content is meant to go.
 * The map delete stays synchronous — the send/distill paths read `chats.has` as
 * their cancellation signal.
 */
export async function disposeComposerChat(
  repo: RepoRef,
  chatId: string,
  opts?: { discard?: boolean },
): Promise<void> {
  const key = chatKey(repo, chatId);
  inFlight.get(key)?.abort();
  const record = chats.get(key);
  chats.delete(key);
  if (!deps || !record) return;
  // Attachments outlive the record only for as long as a draft can resume it:
  // a discarded session or one with nothing worth capturing takes them along.
  const discarded = opts?.discard || record.discarded;
  if (discarded || (!record.draftId && !hasCaptureContent(record))) {
    await deleteAttachmentsDir(deps.attachmentsDir, record.chatId).catch(() => {
      /* best-effort: the next composer init sweeps what is left */
    });
  }
  if (discarded || record.draftId || !hasCaptureContent(record)) return;
  record.unfinished = true;
  try {
    await saveComposerDraftFile(deps.draftsDir, storedFrom(record, chatId));
    await deleteUnfinishedDraftFiles(
      deps.draftsDir,
      repoKey(record.repo),
      unfinishedKeepIds(chatId),
      dropAttachmentsOf,
    );
    deps.onDraftsChanged();
  } catch {
    /* capture is best-effort, like autosave — a lost one leaves the list as it was */
  }
}

/** A swept unfinished draft takes its attachments with it (#281). */
function dropAttachmentsOf(draft: StoredComposerDraft): void {
  if (!deps || hasLiveComposerChat(draft.chatId)) return;
  void deleteAttachmentsDir(deps.attachmentsDir, draft.chatId).catch(() => {
    /* best-effort */
  });
}

/**
 * App quit (#272): `dispose` never runs, so sweep the live unpromoted sessions
 * here. Synchronous by necessity — `before-quit` cannot await, and the failsafe
 * force-exits shortly after. One capture per repo, most recently started wins.
 */
export function flushUnfinishedComposerChats(): void {
  if (!deps) return;
  const promoted = new Set<string>();
  const eligible = new Map<string, ComposerChatRecord>();
  const dropped: ComposerChatRecord[] = [];
  for (const record of chats.values()) {
    if (record.draftId) {
      promoted.add(record.draftId);
      continue;
    }
    if (record.discarded || !hasCaptureContent(record)) {
      dropped.push(record);
      continue;
    }
    const displaced = eligible.get(repoKey(record.repo));
    if (displaced) dropped.push(displaced);
    eligible.set(repoKey(record.repo), record);
  }
  for (const record of dropped) deleteAttachmentsDirSync(deps.attachmentsDir, record.chatId);
  for (const [key, record] of eligible) {
    record.unfinished = true;
    try {
      saveComposerDraftFileSync(deps.draftsDir, storedFrom(record, record.chatId));
    } catch {
      continue;
    }
    deleteUnfinishedDraftFilesSync(
      deps.draftsDir,
      key,
      new Set([record.chatId, ...promoted]),
      (draft) => deleteAttachmentsDirSync(deps!.attachmentsDir, draft.chatId),
    );
  }
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
    ...(record.unfinished ? { unfinished: true } : {}),
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
  // An explicit save is what makes a draft permanent: it leaves the unfinished
  // overwrite pool (#272), on disk and in the record.
  delete record.unfinished;
  delete record.discarded;
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
    ...(stored.unfinished ? { unfinished: true } : {}),
    createdAt: stored.createdAt,
  });
  deps.emitEvent(key, { kind: "status", phase: "fetching", detail: "composer resume" });
  return {
    ok: true,
    chatId: stored.chatId,
    ...(stored.unfinished ? { unfinished: true } : {}),
  };
}

/** Drop the draft link from whichever live chat holds it (#138): without this a
 *  deleted draft would be resurrected by the next autosave. */
export function demoteComposerDraft(draftId: string): void {
  for (const record of chats.values()) {
    if (record.draftId !== draftId) continue;
    delete record.draftId;
    // The draft was deleted or published: dispose must not capture it back as an
    // unfinished draft (#272).
    record.discarded = true;
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

/** Attachments are re-validated here, not trusted from the renderer: the paths
 *  cross the IPC boundary and end up in a prompt telling the agent to read them. */
async function resolveAttachments(
  chatId: string,
  attachments: PlanChatAttachment[],
): Promise<PlanChatAttachment[]> {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
  }
  const resolved: PlanChatAttachment[] = [];
  for (const attachment of attachments) {
    const path = assertAttachmentPath(deps!.attachmentsDir, chatId, attachment.path);
    await access(path);
    resolved.push({ name: attachment.name, path });
  }
  return resolved;
}

export async function sendComposerChatMessage(
  repo: RepoRef,
  chatId: string,
  text: string,
  attachments?: PlanChatAttachment[],
): Promise<SendComposerChatResult> {
  if (!deps) return { ok: false, error: "composer not initialized" };
  const message = text.trim();
  if (!message) return { ok: false, error: "message is empty" };
  const key = chatKey(repo, chatId);
  if (inFlight.has(key)) return { ok: false, error: "chat turn already running" };
  const record = chats.get(key);
  if (!record) return { ok: false, error: "unknown composer chat" };

  let attached: PlanChatAttachment[];
  try {
    attached = attachments?.length ? await resolveAttachments(chatId, attachments) : [];
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

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
      ...(attached.length > 0 ? { attachments: attached.map((a) => a.path) } : {}),
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
    record.messages.push({
      role: "user",
      text: message,
      at,
      ...(attached.length > 0 ? { attachments: attached } : {}),
    });
    record.messages.push({ role: "assistant", text: reply.reply, at: new Date().toISOString() });
    if (sessionToRecord) {
      record.sessionId = sessionToRecord;
      record.sessionRuntimeId = ctx.runtime?.id;
    }
    autosave(record);
    return { ok: true, reply: reply.reply };
  } catch (err) {
    if (err instanceof AgentAbortError) return { ok: false, cancelled: true };
    const kind = chatErrorKind(err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(kind ? { errorKind: kind } : {}),
    };
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
