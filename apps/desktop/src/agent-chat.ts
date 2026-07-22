import { randomUUID } from "node:crypto";
import {
  AgentAbortError,
  createProvider,
  discussCoder,
  discussReviewer,
  distillCoderChatInstructions,
  type CoderChatContext,
  type LLMProviderInterface,
  type MemoryMcp,
  type PlanIssueInput,
  type ReviewerChatContext,
} from "@skipper/core";
import {
  CODER_CHAT_APPLY_STATES,
  type AgentChatKind,
  type CodingEvent,
  type Issue,
  type LlmSettings,
  type PrReviewComment,
  type RepoRef,
  type ResolvedRepoOrchestratorSettings,
  type PlanChatMessage,
  type StoredCoderReport,
  type StoredPlan,
  type TrackedItem,
  type TransitionActor,
} from "@skipper/shared";
import { modelForRole, providerCacheKey } from "./llm-settings";
import {
  appendAgentChatExchange,
  readAgentChat,
  setAgentChatSessionId,
} from "./agent-chat-store";

// Per-tab agent chat (#170): lets the user interrogate the coder (Worktree tab)
// and the reviewer (Review tab), one parametrized runner for both kinds. Mirrors
// plan-chat.ts's battle-tested idioms (sync in-flight claim, persist-before-run,
// dead-resume retry, drift capture, post-turn re-check). Discuss-only — neither
// chat mutates anything, and neither ever writes item.worktree/review.sessionId
// (the chat keeps its own session lineage in its store file, D1).

export interface AgentChatDeps {
  getItem: (itemId: string) => TrackedItem | undefined;
  getIssue: (item: TrackedItem) => Issue | undefined;
  getRepoPath: (repo: RepoRef) => string | undefined;
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  getStoredPlan: (item: TrackedItem) => Promise<StoredPlan | null>;
  getCoderReport: (item: TrackedItem) => Promise<StoredCoderReport | null>;
  getLlmSettings: () => Promise<LlmSettings>;
  /** Route to the coding console (coder) or the review console (reviewer). */
  emitEvent: (kind: AgentChatKind, itemId: string, event: CodingEvent) => void;
  plansDir: string;
  getMemoryMcp?: (item: TrackedItem) => MemoryMcp | undefined;
  /** Coder-chat Apply re-entry (#188): comments → coding, in one manifest write. */
  completeReentry: (
    itemId: string,
    comments: PrReviewComment[],
    reason: string,
    actor?: TransitionActor,
  ) => Promise<void>;
}

export type SendAgentChatResult =
  | { ok: true; reply: string; mode: "resumed" | "fresh" }
  | { ok: false; error?: string; cancelled?: boolean };

export type PrepareCoderChatApplyResult =
  | { ok: true; instructions: PrReviewComment[] }
  | { ok: false; error?: string; cancelled?: boolean };

export type ConfirmCoderChatApplyResult = { ok: true } | { ok: false; error?: string };

interface KindConfig {
  available: (item: TrackedItem) => boolean;
  /** Turn-1 resume source — the agent's own session (never the chat's). */
  turn1Source: (item: TrackedItem) => string | undefined;
  /** Supersession binding; undefined = no transcript yet. */
  binding: (item: TrackedItem) => string | undefined;
  roleModel: (settings: ResolvedRepoOrchestratorSettings) => string;
  /** Reviewer discusses from the repo clone when the worktree is gone. */
  repoCwdFallback: boolean;
  detail: string;
}

const CONFIGS: Record<AgentChatKind, KindConfig> = {
  coder: {
    available: (item) => !!item.worktree?.path && item.state !== "coding",
    turn1Source: (item) => item.worktree?.sessionId,
    binding: (item) => item.worktree?.path,
    roleModel: (s) => s.coderModel,
    repoCwdFallback: false,
    detail: "coder chat",
  },
  reviewer: {
    available: (item) => item.review != null && item.state !== "agent-review",
    turn1Source: (item) => item.review?.sessionId,
    binding: (item) => item.review?.at,
    roleModel: (s) => s.reviewerModel,
    repoCwdFallback: true,
    detail: "reviewer chat",
  },
};

let deps: AgentChatDeps | null = null;
let injected = false;
let injectedProvider: LLMProviderInterface | null = null;
const providers = new Map<string, LLMProviderInterface>();
const inFlight = new Map<string, AbortController>();

function flightKey(kind: AgentChatKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

export function initAgentChat(agentChatDeps: AgentChatDeps, provider?: LLMProviderInterface): void {
  deps = agentChatDeps;
  injected = provider !== undefined;
  injectedProvider = provider ?? null;
  providers.clear();
  inFlight.clear();
}

async function resolveProvider(roleModel: string): Promise<LLMProviderInterface> {
  if (injected && injectedProvider) return injectedProvider;
  const settings = await deps!.getLlmSettings();
  const model = modelForRole(settings, roleModel);
  const key = providerCacheKey(settings, model);
  let provider = providers.get(key);
  if (!provider) {
    provider = createProvider({
      provider: settings.provider,
      model,
      maxTurns: 5,
      apiKey: settings.provider === "openai" ? settings.openaiApiKey : undefined,
    });
    providers.set(key, provider);
  }
  return provider;
}

function toPlanIssue(item: TrackedItem, cached: Issue | undefined): PlanIssueInput {
  return {
    key: item.key,
    title: item.title,
    url: item.url,
    labels: cached?.labels ?? [],
    ...(cached?.body ? { body: cached.body } : {}),
  };
}

/** Transcript bound to the current binding; a stale one is dropped. */
async function historyFor(
  kind: AgentChatKind,
  itemId: string,
  binding: string,
): Promise<PlanChatMessage[]> {
  const chat = await readAgentChat(deps!.plansDir, kind, itemId);
  if (!chat) return [];
  if (chat.binding !== binding) return [];
  return chat.messages;
}

export async function getAgentChatHistory(
  kind: AgentChatKind,
  itemId: string,
): Promise<PlanChatMessage[]> {
  if (!deps) return [];
  const item = deps.getItem(itemId);
  if (!item) return [];
  const binding = CONFIGS[kind].binding(item);
  if (!binding) return [];
  return historyFor(kind, itemId, binding);
}

export function cancelAgentChat(kind: AgentChatKind, itemId: string): void {
  inFlight.get(flightKey(kind, itemId))?.abort();
}

async function buildContext(
  kind: AgentChatKind,
  item: TrackedItem,
  history: PlanChatMessage[],
): Promise<CoderChatContext | ReviewerChatContext> {
  const issue = toPlanIssue(item, deps!.getIssue(item));
  const storedPlan = await deps!.getStoredPlan(item);
  const storedReport = await deps!.getCoderReport(item);
  const base: CoderChatContext = {
    issue,
    history,
    ...(storedPlan?.plan ? { plan: storedPlan.plan } : {}),
    ...(storedReport?.report ? { report: storedReport.report } : {}),
  };
  if (kind === "coder") return base;
  const review = item.review!;
  return {
    ...base,
    review: {
      outcome: review.outcome,
      rounds: review.rounds,
      ...(review.reason ? { reason: review.reason } : {}),
      ...(review.objections ? { objections: review.objections } : {}),
    },
  };
}

export async function sendAgentChatMessage(
  kind: AgentChatKind,
  itemId: string,
  text: string,
  opts?: { selectedFile?: string },
): Promise<SendAgentChatResult> {
  if (!deps) return { ok: false, error: "agent chat not initialized" };
  const message = text.trim();
  if (!message) return { ok: false, error: "message is empty" };
  const key = flightKey(kind, itemId);
  if (inFlight.has(key)) return { ok: false, error: "chat turn already running" };

  const cfg = CONFIGS[kind];
  const item = deps.getItem(itemId);
  if (!item) return { ok: false, error: `unknown item ${itemId}` };
  if (!cfg.available(item)) {
    return { ok: false, error: `${kind} chat is not available (item is ${item.state})` };
  }
  const binding = cfg.binding(item);
  if (!binding) return { ok: false, error: `${kind} chat has no binding` };

  // Claim the slot synchronously (before any await) so a concurrent send busy-guards.
  const controller = new AbortController();
  inFlight.set(key, controller);
  try {
    const cwd =
      item.worktree?.path ?? (cfg.repoCwdFallback ? deps.getRepoPath(item.repo) : undefined);
    if (!cwd) return { ok: false, error: "repo not linked" };

    const provider = await resolveProvider(cfg.roleModel(deps.getRepoSettings(item.repo)));
    const memory = deps.getMemoryMcp?.(item);
    const history = await historyFor(kind, itemId, binding);

    // The chat owns its session lineage (D1): turn 1 resumes the agent's session
    // (worktree/review sessionId), later turns resume the chat store's own id.
    const chat = await readAgentChat(deps.plansDir, kind, itemId);
    const storeSessionId = chat && chat.binding === binding ? chat.sessionId : undefined;
    const resumeSessionId = storeSessionId ?? cfg.turn1Source(item);
    const resumable =
      provider.name === "claude-cli" && !!resumeSessionId && !!item.worktree?.path;

    // Mint a persist-before-run session for any fresh (fallback / dead-resume) run.
    const fallbackSessionId =
      provider.name === "claude-cli" && item.worktree?.path ? randomUUID() : undefined;

    deps.emitEvent(kind, itemId, { kind: "status", phase: "resuming", detail: cfg.detail });

    // Drift capture: --resume forks and reports a NEW id via agent-init. Track it
    // in memory and persist to the chat store (never the manifest, D1) AFTER the
    // turn — writing it here would race the transcript append on the same file.
    let sessionToPersist: string | undefined = resumable ? resumeSessionId : fallbackSessionId;
    let sawEvent = false;
    const onEvent = (event: CodingEvent) => {
      sawEvent = true;
      if (event.kind === "agent-init" && event.sessionId) {
        sessionToPersist = event.sessionId;
      }
      deps?.emitEvent(kind, itemId, event);
    };

    const runFallback = async () => {
      // Persist-before-run so a crash still leaves a resumable pointer, and make
      // the minted id the one we persist post-turn (the resume source is dead here).
      if (fallbackSessionId) {
        await setAgentChatSessionId(deps!.plansDir, kind, itemId, binding, fallbackSessionId);
        sessionToPersist = fallbackSessionId;
      }
      const context = await buildContext(kind, item, history);
      const common = {
        message,
        llm: provider,
        cwd,
        onEvent,
        ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}),
        ...(memory ? { memory } : {}),
        signal: controller.signal,
      };
      return kind === "coder"
        ? discussCoder({
            ...common,
            context: context as CoderChatContext,
            ...(opts?.selectedFile ? { selectedFile: opts.selectedFile } : {}),
          })
        : discussReviewer({ ...common, context: context as ReviewerChatContext });
    };

    const runResume = async () => {
      const common = {
        message,
        llm: provider,
        cwd,
        resumeSessionId: resumeSessionId!,
        onEvent,
        ...(memory ? { memory } : {}),
        signal: controller.signal,
      };
      return kind === "coder"
        ? discussCoder({ ...common, ...(opts?.selectedFile ? { selectedFile: opts.selectedFile } : {}) })
        : discussReviewer(common);
    };

    let mode: "resumed" | "fresh" = resumable ? "resumed" : "fresh";
    let reply: { reply: string; sessionId?: string };
    try {
      reply = resumable ? await runResume() : await runFallback();
    } catch (err) {
      // A dead --resume (session gone from disk) fails fast without events:
      // retry once as a fresh, fully-seeded run (coder.ts dead-resume idiom).
      if (!resumable || sawEvent || err instanceof AgentAbortError) throw err;
      mode = "fresh";
      reply = await runFallback();
    }

    // Cooperative cancel: persist nothing if the turn was aborted, the chat is no
    // longer available (transition into the blocking state), or the binding drifted.
    const after = deps.getItem(itemId);
    if (
      controller.signal.aborted ||
      !after ||
      !cfg.available(after) ||
      cfg.binding(after) !== binding
    ) {
      return { ok: false, cancelled: true };
    }
    await appendAgentChatExchange(deps.plansDir, kind, itemId, binding, message, reply.reply);
    // Persist the chat's own session lineage last, so the transcript append never
    // clobbers a drifted id (both write the same file).
    if (sessionToPersist) {
      await setAgentChatSessionId(deps.plansDir, kind, itemId, binding, sessionToPersist);
    }
    return { ok: true, reply: reply.reply, mode };
  } catch (err) {
    if (err instanceof AgentAbortError) return { ok: false, cancelled: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Coder-chat Apply (#188), step 1: distill the discussion into re-entry
 * instructions for a preview. Coder-only, no state mutation, no transcript
 * append (like plan apply). Shares the send path's session lineage and busy
 * guard (the same inFlight slot), so a distillation and a send can't overlap.
 */
export async function prepareCoderChatApply(itemId: string): Promise<PrepareCoderChatApplyResult> {
  if (!deps) return { ok: false, error: "agent chat not initialized" };
  const key = flightKey("coder", itemId);
  if (inFlight.has(key)) return { ok: false, error: "chat turn already running" };

  const cfg = CONFIGS.coder;
  const item = deps.getItem(itemId);
  if (!item) return { ok: false, error: `unknown item ${itemId}` };
  if (!cfg.available(item)) {
    return { ok: false, error: `coder chat is not available (item is ${item.state})` };
  }
  if (!CODER_CHAT_APPLY_STATES.includes(item.state)) {
    return { ok: false, error: `coder chat apply is not available (item is ${item.state})` };
  }
  const binding = cfg.binding(item);
  if (!binding) return { ok: false, error: "coder chat has no binding" };

  // Claim the slot synchronously (before any await) so a concurrent send/apply busy-guards.
  const controller = new AbortController();
  inFlight.set(key, controller);
  try {
    const history = await historyFor("coder", itemId, binding);
    if (history.length === 0) return { ok: false, error: "no discussion to apply" };

    const cwd = item.worktree?.path;
    if (!cwd) return { ok: false, error: "repo not linked" };

    const provider = await resolveProvider(cfg.roleModel(deps.getRepoSettings(item.repo)));
    const memory = deps.getMemoryMcp?.(item);

    // Session lineage mirrors the send path (D1): the chat store's own id when it
    // exists, else the coder's worktree session for turn 1.
    const chat = await readAgentChat(deps.plansDir, "coder", itemId);
    const storeSessionId = chat && chat.binding === binding ? chat.sessionId : undefined;
    const resumeSessionId = storeSessionId ?? cfg.turn1Source(item);
    const resumable =
      provider.name === "claude-cli" && !!resumeSessionId && !!item.worktree?.path;
    const fallbackSessionId =
      provider.name === "claude-cli" && item.worktree?.path ? randomUUID() : undefined;

    deps.emitEvent("coder", itemId, { kind: "status", phase: "resuming", detail: "apply coder chat" });

    let sessionToPersist: string | undefined = resumable ? resumeSessionId : fallbackSessionId;
    let sawEvent = false;
    const onEvent = (event: CodingEvent) => {
      sawEvent = true;
      if (event.kind === "agent-init" && event.sessionId) sessionToPersist = event.sessionId;
      deps?.emitEvent("coder", itemId, event);
    };

    const runFallback = async () => {
      if (fallbackSessionId) {
        await setAgentChatSessionId(deps!.plansDir, "coder", itemId, binding, fallbackSessionId);
        sessionToPersist = fallbackSessionId;
      }
      const context = (await buildContext("coder", item, history)) as CoderChatContext;
      return distillCoderChatInstructions({
        llm: provider,
        cwd,
        context,
        onEvent,
        ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}),
        ...(memory ? { memory } : {}),
        signal: controller.signal,
      });
    };

    const runResume = async () =>
      distillCoderChatInstructions({
        llm: provider,
        cwd,
        resumeSessionId: resumeSessionId!,
        onEvent,
        ...(memory ? { memory } : {}),
        signal: controller.signal,
      });

    let result: { instructions: { path?: string; body: string }[]; sessionId?: string };
    try {
      result = resumable ? await runResume() : await runFallback();
    } catch (err) {
      // A dead --resume fails fast without events: retry once as a fresh, seeded run.
      if (!resumable || sawEvent || err instanceof AgentAbortError) throw err;
      result = await runFallback();
    }

    // Cooperative cancel: discard a distillation that raced a transition out of
    // the apply set, an untrack, or a binding drift.
    const after = deps.getItem(itemId);
    if (
      controller.signal.aborted ||
      !after ||
      !cfg.available(after) ||
      !CODER_CHAT_APPLY_STATES.includes(after.state) ||
      cfg.binding(after) !== binding
    ) {
      return { ok: false, cancelled: true };
    }

    // Persist the chat's own session lineage (never a transcript append — apply doesn't).
    if (sessionToPersist) {
      await setAgentChatSessionId(deps.plansDir, "coder", itemId, binding, sessionToPersist);
    }
    const instructions: PrReviewComment[] = result.instructions.map((i) => ({
      author: "coder-chat",
      body: i.body,
      ...(i.path ? { path: i.path } : {}),
    }));
    return { ok: true, instructions };
  } catch (err) {
    if (err instanceof AgentAbortError) return { ok: false, cancelled: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Coder-chat Apply (#188), step 2: commit the previewed instructions. Fires the
 * re-entry (comments → coding) via completeReentry — the same contract as the
 * changes-requested re-entry; the coder's prFixMode applies the changes.
 */
export async function confirmCoderChatApply(
  itemId: string,
  instructions: PrReviewComment[],
): Promise<ConfirmCoderChatApplyResult> {
  if (!deps) return { ok: false, error: "agent chat not initialized" };
  if (inFlight.has(flightKey("coder", itemId))) {
    return { ok: false, error: "chat turn already running" };
  }
  const item = deps.getItem(itemId);
  if (!item) return { ok: false, error: `unknown item ${itemId}` };
  if (!CODER_CHAT_APPLY_STATES.includes(item.state)) {
    return { ok: false, error: `coder chat apply is not available (item is ${item.state})` };
  }
  if (instructions.length === 0) return { ok: false, error: "no instructions to apply" };
  try {
    await deps.completeReentry(itemId, instructions, "coder chat apply", "user");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
