import { randomUUID } from "node:crypto";
import {
  AgentAbortError,
  PlanGenerationError,
  applyPlanFromDiscussion,
  discussPlan,
  type LLMProviderInterface,
  type MemoryMcp,
  type PlanIssueInput,
  type RunConfinement,
} from "@skipper/core";
import { checkoutEscapeReason, newDirtyPaths } from "./worktrees";
import {
  CHAT_TURN_DETAILS,
  diffCount,
  diffPlans,
  isPlanChatText,
  sessionRuntimeOf,
} from "@skipper/shared";
import type {
  AgentRuntimeId,
  CodingEvent,
  Issue,
  IssuePlan,
  LlmSettings,
  PlanChatMessage,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { buildLlm, injectedBundle, modelForRole, providerCacheKey, type LlmBundle } from "./llm-settings";
import {
  appendPlanChatApplied,
  appendPlanChatExchange,
  deletePlanChat,
  readPlanChat,
} from "./plan-chat-store";

// Conversational plan review (#145): lets the user chat with the planning
// session while an item sits at plan-gate. Two explicit modes — Discuss (pure
// Q&A, plan untouched) and Apply (re-emit the plan). Resumes the plan session
// (same LLM, repo exploration intact) when it survives, else runs a fresh,
// fully-seeded turn. One turn at a time per item; a transition out of plan-gate
// aborts a live turn.

export interface PlanChatDeps {
  getItem: (itemId: string) => TrackedItem | undefined;
  getIssue: (item: TrackedItem) => Issue | undefined;
  getRepoPath: (repo: RepoRef) => string | undefined;
  /** Uncommitted paths in the checkout (git status --porcelain); null if git fails (#196). */
  checkoutDirtyPaths: (repoPath: string) => Promise<string[] | null>;
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  getStoredPlan: (item: TrackedItem) => Promise<StoredPlan | null>;
  /** Overwrite the stored plan, stamping editedAt (updateStoredPlan wrapper). */
  updatePlan: (item: TrackedItem, plan: IssuePlan) => Promise<StoredPlan | null>;
  setPlanSessionId: (itemId: string, sessionId: string, sessionRuntime?: AgentRuntimeId) => Promise<void>;
  getLlmSettings: () => Promise<LlmSettings>;
  /** Planner console stream (= emitPlanningEvent); resuming/CLI events only, never agent-start. */
  emitEvent: (itemId: string, event: CodingEvent) => void;
  plansDir: string;
  getMemoryMcp?: (item: TrackedItem) => MemoryMcp | undefined;
}

export type SendPlanChatResult =
  | { ok: true; reply: string }
  | { ok: false; error?: string; cancelled?: boolean };

export type ApplyPlanChatResult =
  | { ok: true; stored: StoredPlan }
  | { ok: false; error?: string; cancelled?: boolean };

let deps: PlanChatDeps | null = null;
let injected = false;
let injectedProvider: LLMProviderInterface | null = null;
let bundle: LlmBundle | null = null;
let bundleKey: string | null = null;
const inFlight = new Map<string, AbortController>();

export function initPlanChat(planChatDeps: PlanChatDeps, provider?: LLMProviderInterface): void {
  deps = planChatDeps;
  injected = provider !== undefined;
  injectedProvider = provider ?? null;
  bundle = null;
  bundleKey = null;
  inFlight.clear();
}

/** Bundle resolution mirrors the planner (role = plannerModel). */
async function resolveBundle(roleModel: string, roleRuntime: AgentRuntimeId): Promise<LlmBundle> {
  if (injected && injectedProvider) return injectedBundle(injectedProvider, roleModel, roleRuntime);
  const settings = await deps!.getLlmSettings();
  const model = modelForRole(settings, roleModel);
  const key = providerCacheKey(settings, model, roleRuntime);
  if (!bundle || bundleKey !== key) {
    bundle = buildLlm(settings, roleModel, 5, roleRuntime);
    bundleKey = key;
  }
  return bundle;
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

/** History bound to this plan generation; a stale transcript is dropped. */
async function historyFor(itemId: string, planGeneratedAt: string): Promise<PlanChatMessage[]> {
  const chat = await readPlanChat(deps!.plansDir, itemId);
  if (!chat) return [];
  if (chat.planGeneratedAt !== planGeneratedAt) {
    await deletePlanChat(deps!.plansDir, itemId).catch(() => {});
    return [];
  }
  return chat.messages;
}

export async function getPlanChatHistory(itemId: string): Promise<PlanChatMessage[]> {
  if (!deps) return [];
  const item = deps.getItem(itemId);
  if (!item) return [];
  const stored = await deps.getStoredPlan(item);
  if (!stored) return [];
  return historyFor(itemId, stored.generatedAt);
}

export function cancelPlanChat(itemId: string): void {
  inFlight.get(itemId)?.abort();
}

export async function sendPlanChatMessage(itemId: string, text: string): Promise<SendPlanChatResult> {
  if (!deps) return { ok: false, error: "plan chat not initialized" };
  const message = text.trim();
  if (!message) return { ok: false, error: "message is empty" };
  if (inFlight.has(itemId)) return { ok: false, error: "chat turn already running" };

  const item = deps.getItem(itemId);
  if (!item) return { ok: false, error: `unknown item ${itemId}` };
  if (item.state !== "plan-gate") {
    return { ok: false, error: `plan chat is only available at the gate (item is ${item.state})` };
  }

  // Claim the slot synchronously (before any await) so a concurrent send/apply busy-guards.
  const controller = new AbortController();
  inFlight.set(itemId, controller);
  try {
    const stored = await deps.getStoredPlan(item);
    if (!stored) return { ok: false, error: "item has no stored plan" };

    const cwd = item.worktree?.path ?? deps.getRepoPath(item.repo);
    if (!cwd) return { ok: false, error: "repo not linked" };
    const repoPath = deps.getRepoPath(item.repo);
    const checkoutBefore = repoPath ? await deps.checkoutDirtyPaths(repoPath) : null;

    const planRepoSettings = deps.getRepoSettings(item.repo);
    const { llm: provider, runtime } = await resolveBundle(
      planRepoSettings.plannerModel,
      planRepoSettings.plannerRuntime,
    );
    const resumable =
      !!runtime?.capabilities.resume &&
      sessionRuntimeOf(item.plan) === runtime.id &&
      !!item.plan?.sessionId &&
      !!item.worktree?.path;

    const issue = toPlanIssue(item, deps.getIssue(item));
    const history = await historyFor(itemId, stored.generatedAt);
    const memory = deps.getMemoryMcp?.(item);
    // Confinement (#196): only when the chat runs IN the worktree; the checkout
    // is the deny root either way and the tripwire below guards both.
    const confinement: RunConfinement | undefined =
      item.worktree?.path && repoPath
        ? {
            runRoot: cwd,
            denyRoots: [repoPath],
            ...(memory?.cliBundlePath ? { cliBundlePath: memory.cliBundlePath } : {}),
          }
        : undefined;
    // Mint a persist-before-run session for any fresh (fallback / dead-resume)
    // run so a crash still leaves a resumable pointer (planner.ts rationale).
    const fallbackSessionId =
      runtime?.capabilities.resume && item.worktree?.path ? randomUUID() : undefined;

    deps.emitEvent(itemId, {
      kind: "status",
      phase: "resuming",
      detail: CHAT_TURN_DETAILS.planChat,
    });

    let persistedSessionId: string | undefined = resumable ? item.plan!.sessionId : undefined;
    let sawEvent = false;
    const onEvent = (event: CodingEvent) => {
      sawEvent = true;
      if (event.kind === "agent-init" && persistedSessionId && event.sessionId !== persistedSessionId) {
        persistedSessionId = event.sessionId;
        void deps?.setPlanSessionId(itemId, event.sessionId, runtime?.id).catch(() => {});
      }
      deps?.emitEvent(itemId, event);
    };

    const runFallback = async () => {
      if (fallbackSessionId) {
        await deps!.setPlanSessionId(itemId, fallbackSessionId, runtime?.id);
        persistedSessionId = fallbackSessionId;
      }
      return discussPlan({
        message,
        llm: provider,
        ...(runtime ? { runtime } : {}),
        cwd,
        context: {
          issue,
          plan: stored.plan,
          history,
          ...(stored.confidence ? { confidence: stored.confidence } : {}),
        },
        onEvent,
        ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}),
        ...(memory ? { memory } : {}),
        ...(confinement ? { confinement } : {}),
        signal: controller.signal,
      });
    };

    let reply: { reply: string; sessionId?: string };
    try {
      reply = resumable
        ? await discussPlan({
            message,
            llm: provider,
            ...(runtime ? { runtime } : {}),
            cwd,
            resumeSessionId: item.plan!.sessionId!,
            // The resumed session persists its context across turns, so inject
            // the (~3k-char) confidence report once, on the first turn only.
            ...(history.length === 0 && stored.confidence ? { confidence: stored.confidence } : {}),
            onEvent,
            ...(memory ? { memory } : {}),
            ...(confinement ? { confinement } : {}),
            signal: controller.signal,
          })
        : await runFallback();
    } catch (err) {
      // A dead --resume (session gone from disk) fails fast without events:
      // retry once as a fresh, fully-seeded run (coder.ts dead-resume idiom).
      if (!resumable || sawEvent || err instanceof AgentAbortError) throw err;
      reply = await runFallback();
    }

    // Confinement tripwire (#196): a discuss turn must never touch the checkout.
    if (checkoutBefore !== null && repoPath) {
      const after = await deps.checkoutDirtyPaths(repoPath);
      if (after !== null) {
        const escaped = newDirtyPaths(checkoutBefore, after);
        if (escaped.length > 0) return { ok: false, error: checkoutEscapeReason(escaped) };
      }
    }

    // Cooperative cancel: persist nothing if the turn was aborted or the item
    // left plan-gate (approve/replan/park) mid-run.
    if (controller.signal.aborted || deps.getItem(itemId)?.state !== "plan-gate") {
      return { ok: false, cancelled: true };
    }
    await appendPlanChatExchange(deps.plansDir, itemId, stored.generatedAt, message, reply.reply);
    return { ok: true, reply: reply.reply };
  } catch (err) {
    if (err instanceof AgentAbortError) return { ok: false, cancelled: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(itemId);
  }
}

export async function applyPlanChatUpdate(itemId: string): Promise<ApplyPlanChatResult> {
  if (!deps) return { ok: false, error: "plan chat not initialized" };
  if (inFlight.has(itemId)) return { ok: false, error: "chat turn already running" };

  const item = deps.getItem(itemId);
  if (!item) return { ok: false, error: `unknown item ${itemId}` };
  if (item.state !== "plan-gate") {
    return { ok: false, error: `plan chat is only available at the gate (item is ${item.state})` };
  }

  // Claim the slot synchronously (before any await) so a concurrent send/apply busy-guards.
  const controller = new AbortController();
  inFlight.set(itemId, controller);
  try {
    const stored = await deps.getStoredPlan(item);
    if (!stored) return { ok: false, error: "item has no stored plan" };
    const history = await historyFor(itemId, stored.generatedAt);
    if (history.filter(isPlanChatText).length === 0) {
      return { ok: false, error: "no discussion to apply" };
    }

    const cwd = item.worktree?.path ?? deps.getRepoPath(item.repo);
    if (!cwd) return { ok: false, error: "repo not linked" };
    const repoPath = deps.getRepoPath(item.repo);
    const checkoutBefore = repoPath ? await deps.checkoutDirtyPaths(repoPath) : null;

    const planRepoSettings = deps.getRepoSettings(item.repo);
    const { llm: provider, runtime } = await resolveBundle(
      planRepoSettings.plannerModel,
      planRepoSettings.plannerRuntime,
    );
    const resumable =
      !!runtime?.capabilities.resume &&
      sessionRuntimeOf(item.plan) === runtime.id &&
      !!item.plan?.sessionId &&
      !!item.worktree?.path;

    const issue = toPlanIssue(item, deps.getIssue(item));
    const memory = deps.getMemoryMcp?.(item);
    const confinement: RunConfinement | undefined =
      item.worktree?.path && repoPath
        ? {
            runRoot: cwd,
            denyRoots: [repoPath],
            ...(memory?.cliBundlePath ? { cliBundlePath: memory.cliBundlePath } : {}),
          }
        : undefined;
    const fallbackSessionId =
      runtime?.capabilities.resume && item.worktree?.path ? randomUUID() : undefined;

    deps.emitEvent(itemId, {
      kind: "status",
      phase: "resuming",
      detail: CHAT_TURN_DETAILS.planApply,
    });

    let persistedSessionId: string | undefined = resumable ? item.plan!.sessionId : undefined;
    let sawEvent = false;
    const onEvent = (event: CodingEvent) => {
      sawEvent = true;
      if (event.kind === "agent-init" && persistedSessionId && event.sessionId !== persistedSessionId) {
        persistedSessionId = event.sessionId;
        void deps?.setPlanSessionId(itemId, event.sessionId, runtime?.id).catch(() => {});
      }
      deps?.emitEvent(itemId, event);
    };

    const runFallback = async () => {
      if (fallbackSessionId) {
        await deps!.setPlanSessionId(itemId, fallbackSessionId, runtime?.id);
        persistedSessionId = fallbackSessionId;
      }
      return applyPlanFromDiscussion({
        llm: provider,
        ...(runtime ? { runtime } : {}),
        cwd,
        plan: stored.plan,
        issue,
        history,
        ...(stored.confidence ? { confidence: stored.confidence } : {}),
        onEvent,
        ...(fallbackSessionId ? { sessionId: fallbackSessionId } : {}),
        ...(memory ? { memory } : {}),
        ...(confinement ? { confinement } : {}),
        signal: controller.signal,
      });
    };

    let result: { plan: IssuePlan; sessionId?: string };
    try {
      result = resumable
        ? await applyPlanFromDiscussion({
            llm: provider,
            ...(runtime ? { runtime } : {}),
            cwd,
            plan: stored.plan,
            resumeSessionId: item.plan!.sessionId!,
            ...(stored.confidence ? { confidence: stored.confidence } : {}),
            onEvent,
            ...(memory ? { memory } : {}),
            ...(confinement ? { confinement } : {}),
            signal: controller.signal,
          })
        : await runFallback();
    } catch (err) {
      if (!resumable || sawEvent || err instanceof AgentAbortError) throw err;
      result = await runFallback();
    }

    if (controller.signal.aborted) return { ok: false, cancelled: true };
    // Confinement tripwire (#196): the distillation must never touch the checkout.
    if (checkoutBefore !== null && repoPath) {
      const afterDirty = await deps.checkoutDirtyPaths(repoPath);
      if (afterDirty !== null) {
        const escaped = newDirtyPaths(checkoutBefore, afterDirty);
        if (escaped.length > 0) return { ok: false, error: checkoutEscapeReason(escaped) };
      }
    }
    // Re-check the gate AND that the plan wasn't replanned/inline-edited under us.
    const after = deps.getItem(itemId);
    if (after?.state !== "plan-gate") return { ok: false, cancelled: true };
    const current = await deps.getStoredPlan(after);
    if (!current || current.generatedAt !== stored.generatedAt) {
      return { ok: false, cancelled: true };
    }

    const updated = await deps.updatePlan(after, result.plan);
    if (!updated) return { ok: false, error: "stored plan not found" };
    const changeCount = diffCount(diffPlans(current.plan, result.plan));
    try {
      await appendPlanChatApplied(deps.plansDir, itemId, stored.generatedAt, changeCount);
    } catch {
      // marker is cosmetic — the apply already succeeded
    }
    return { ok: true, stored: updated };
  } catch (err) {
    if (err instanceof AgentAbortError) return { ok: false, cancelled: true };
    if (err instanceof PlanGenerationError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(itemId);
  }
}
