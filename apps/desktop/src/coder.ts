import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  buildCoderPrompt,
  buildCoderRecapPrompt,
  buildCoderSalvagePrompt,
  buildFixPrompt,
  buildPrFixPrompt,
  buildResumePrompt,
  CODER_SYSTEM_PROMPT,
  CodingAbortError,
  CodingTimeoutError,
  compareQueueCandidates,
  withRepoConventions,
  tryParseCoderReport,
  repairCoderReport,
  type AgentRuntime,
  type CoderRecapInput,
  type CodingRunResult,
  type IssueComment,
  type LLMProviderInterface,
  type MemoryMcp,
  type OrchestratorSettings,
  type QueueCandidate,
  type RunConfinement,
} from "@skipper/core";
import { checkoutEscapeReason, newDirtyPaths, porcelainPaths, worktreeDirtyFiles } from "./worktrees";
import { AGENT_MAX_TURNS_BACKSTOP, latestCodingTransitionAt, sessionRuntimeOf } from "@skipper/shared";
import type {
  AgentRuntimeId,
  CoderReport,
  CodingEvent,
  Issue,
  IssuePlan,
  LifecycleState,
  LlmSettings,
  RepoPriority,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredPlan,
  TrackedItem,
  TransitionActor,
} from "@skipper/shared";
import { buildLlm, injectedBundle, modelForRole, providerCacheKey, type LlmBundle } from "./llm-settings";
import { readStoredCoderReport, reportFileName, writeStoredCoderReport } from "./report-store";

// Coding runner loop (issue #9): consumes "queued" items — the approval gate's
// output — one at a time per repo. Creates/reuses an isolated git worktree,
// runs a write-capable claude agent on the stored plan, streams progress via
// emitEvent, and lands the item on agent-review (success), failed (agent
// error) or needs-input (environment problem). The uncommitted worktree diff
// is the deliverable for #10/#13/#14. Mirrors planner.ts: coalesced poke,
// cooperative cancellation, crash recovery for items stuck in "coding".

// Budget-death salvage (#194): a short resumed wrap-up run that extracts an honest
// report from the dead session. Bounded tighter than a real coding run — it must
// only emit the report, not keep working.
const CODER_SALVAGE_MAX_TURNS = 4;
const CODER_SALVAGE_HARD_TIMEOUT_MS = 5 * 60_000;

export interface CoderDeps {
  listItems: () => TrackedItem[];
  getItem: (itemId: string) => TrackedItem | undefined;
  /** Cached inbox issue for the item (labels + body), best-effort. */
  getIssue: (item: TrackedItem) => Issue | undefined;
  /** Fresh issue comments fetched at code time (#144); may reject — the loop degrades. */
  fetchIssueComments?: (item: TrackedItem) => Promise<IssueComment[]>;
  /** The linked repo checkout — the deny root for confinement + the tripwire (#196). */
  getRepoPath: (repo: RepoRef) => string | undefined;
  /** Uncommitted paths in the checkout (git status --porcelain); null if git fails (#196). */
  checkoutDirtyPaths: (repoPath: string) => Promise<string[] | null>;
  getPlan: (item: TrackedItem) => Promise<StoredPlan | null>;
  requestTransition: (
    itemId: string,
    to: LifecycleState,
    actor: TransitionActor,
    reason?: string,
    resumeTo?: LifecycleState,
  ) => Promise<TrackedItem>;
  /** Sets coderReport.ref (or clears it) + the agent-review transition in one
   *  manifest write (#146). ref undefined = degrade, drop any stale report. */
  completeCoding: (
    itemId: string,
    reportRef: string | undefined,
    reason: string,
    expectedCodingAt?: string,
  ) => Promise<void>;
  /** Persists item.worktree (path/branch/sessionId/sessionRuntime) without a transition. */
  setWorktree: (
    itemId: string,
    worktree: { path: string; branch: string; sessionId?: string; sessionRuntime?: AgentRuntimeId },
  ) => Promise<void>;
  /** Fetch + resolve base + ensure worktree; composed in orchestrator.ts.
   *  `refreshBase` resets a reused worktree that holds no work of its own. */
  prepareWorktree: (
    item: TrackedItem,
    opts?: { refreshBase?: boolean },
  ) => Promise<{ path: string; branch: string }>;
  getSettings: () => OrchestratorSettings;
  /** Per-repo intake priority (#15) — feeds the queue ordering. */
  getRepoPriority: (repo: RepoRef) => RepoPriority;
  /** Effective per-repo coding WIP limit (#47) — override, else global default. */
  getRepoWipLimit: (repo: RepoRef) => number;
  /** Every per-repo override resolved against the global bag (#58 reads coderModel). */
  getRepoSettings: (repo: RepoRef) => ResolvedRepoOrchestratorSettings;
  /** The repo's ready agent-instructions doc content (#227), or undefined. */
  getRepoInstructions: (repo: RepoRef) => Promise<string | undefined>;
  /** Buffer + forward one progress event (orchestrator owns the IPC channel). */
  emitEvent: (itemId: string, event: CodingEvent) => void;
  /** skipper-memory MCP for this item's repo (#45); undefined = no CLI bundle. */
  getMemoryMcp?: (item: TrackedItem) => MemoryMcp | undefined;
  /** settings.json llm block (#59) — which provider the report repair runs on. */
  getLlmSettings: () => Promise<LlmSettings>;
  /** Where structured coder reports are persisted (#146) — shared plansDir. */
  plansDir: string;
}

let deps: CoderDeps | null = null;
let runtimeInjected = false;
let injectedRuntime: AgentRuntime | null = null;
let providerInjected = false;
let injectedProvider: LLMProviderInterface | null = null;
let bundle: LlmBundle | null = null;
let bundleKey: string | null = null;
const inFlight = new Map<string, AbortController>();
const activeRepos = new Map<string, number>();
let scanScheduled = false;

export function initCoder(
  coderDeps: CoderDeps,
  runtimeImpl?: AgentRuntime,
  provider?: LLMProviderInterface,
): void {
  deps = coderDeps;
  runtimeInjected = runtimeImpl !== undefined;
  injectedRuntime = runtimeImpl ?? null;
  providerInjected = provider !== undefined;
  injectedProvider = provider ?? null;
  bundle = null;
  bundleKey = null;
  inFlight.clear();
  activeRepos.clear();
}

/** Injected runtime/provider (tests) win; otherwise the bundle built from Settings
 *  (#59/#238), cached per provider+model. The runtime drives the coding run; the
 *  provider is used only for the report repair (#146). Mirrors reviewer.ts. */
async function resolveBundle(roleModel: string, roleRuntime: AgentRuntimeId): Promise<LlmBundle> {
  if (runtimeInjected || providerInjected) {
    const base = injectedProvider
      ? injectedBundle(injectedProvider, roleModel, roleRuntime)
      : ({ llm: undefined as unknown as LLMProviderInterface, model: roleModel } as LlmBundle);
    return { ...base, ...(runtimeInjected ? { runtime: injectedRuntime ?? undefined } : {}) };
  }
  const settings = await deps!.getLlmSettings();
  const model = modelForRole(settings, roleModel);
  const key = providerCacheKey(settings, model, roleRuntime);
  if (!bundle || bundleKey !== key) {
    bundle = buildLlm(settings, roleModel, 5, roleRuntime);
    bundleKey = key;
  }
  return bundle;
}

/** Coalesced re-scan — fired after polls, transitions and completed runs. */
export function pokeCoder(): void {
  if (!deps || scanScheduled) return;
  scanScheduled = true;
  setImmediate(() => {
    scanScheduled = false;
    void scan().catch(() => {
      /* per-item errors already handled in run() */
    });
  });
}

/** Abort a live run (user moved the item out of "coding"). */
export function cancelCodingRun(itemId: string): void {
  inFlight.get(itemId)?.abort();
}

/** Quit teardown — kill every live coding agent. */
export function killAllCodingRuns(): void {
  for (const controller of inFlight.values()) controller.abort();
}

function repoKeyOf(item: TrackedItem): string {
  return `${item.repo.owner.toLowerCase()}/${item.repo.name.toLowerCase()}`;
}

function queuedAt(item: TrackedItem): string {
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    if (item.transitions[i].to === "queued") return item.transitions[i].at;
  }
  return item.createdAt;
}

function toCandidate(item: TrackedItem): QueueCandidate {
  return {
    pinned: item.pinned === true,
    priority: deps!.getRepoPriority(item.repo),
    confidence: item.plan?.confidence,
    queuedAt: queuedAt(item),
  };
}

async function scan(): Promise<void> {
  if (!deps) return;
  // The WIP limit is per-repo (#47): resolved inside the loops because each
  // repo can override the global codingWipPerRepo default.
  const wipLimit = (item: TrackedItem) => Math.max(1, deps!.getRepoWipLimit(item.repo));
  const idle = deps.listItems().filter((item) => !inFlight.has(item.id));

  // Pass 1 — items already in "coding" (PR re-entries + crash recovery) always
  // resume first: they skip the queue but consume the repo's WIP limit. When
  // the repo is at limit they wait for release(), which pokes a rescan.
  const resumes = idle
    .filter((item) => item.state === "coding")
    .sort((a, b) => queuedAt(a).localeCompare(queuedAt(b)));
  for (const item of resumes) {
    const repoKey = repoKeyOf(item);
    if ((activeRepos.get(repoKey) ?? 0) >= wipLimit(item)) continue;
    activeRepos.set(repoKey, (activeRepos.get(repoKey) ?? 0) + 1);
    void run(item.id, repoKey);
  }

  // Pass 2 — the queue proper, in #15 order (pin > priority > confidence > age).
  const queuedItems = idle
    .filter((item) => item.state === "queued")
    .sort((a, b) => compareQueueCandidates(toCandidate(a), toCandidate(b)));
  for (const item of queuedItems) {
    const repoKey = repoKeyOf(item);
    if ((activeRepos.get(repoKey) ?? 0) >= wipLimit(item)) continue;
    // Reserve the slot synchronously, before the transition await (B4): a second
    // scan racing this one would otherwise see the stale count and breach WIP.
    // run()'s finally always release()s, so a failed transition frees it below.
    activeRepos.set(repoKey, (activeRepos.get(repoKey) ?? 0) + 1);
    try {
      await deps.requestTransition(item.id, "coding", "coder", "coding started");
    } catch {
      release(repoKey);
      continue;
    }
    void run(item.id, repoKey);
  }
}

async function run(itemId: string, repoKey: string): Promise<void> {
  if (!deps || inFlight.has(itemId)) {
    release(repoKey);
    return;
  }
  const controller = new AbortController();
  inFlight.set(itemId, controller);
  // Run token (#159, mirrors planner): the timestamp of this entry into coding.
  // A cancel, or an untrack → re-admit that mints a newer coding transition,
  // makes the completion below detectably stale so a zombie can't land its
  // report on the fresh lifecycle.
  let codingAt: string | undefined;
  // Confinement tripwire baseline (#196): the checkout and its dirty set before
  // the run, so the catch can compare too (it can't see try-scoped locals).
  let repoPath: string | undefined;
  let checkoutBefore: string[] | null = null;
  const live = (): boolean => {
    const cur = deps?.getItem(itemId);
    return (
      !controller.signal.aborted &&
      cur?.state === "coding" &&
      latestCodingTransitionAt(cur) === codingAt
    );
  };
  try {
    const item = deps.getItem(itemId);
    if (!item || item.state !== "coding") return;
    codingAt = latestCodingTransitionAt(item);

    const stored = await deps.getPlan(item);
    if (!stored) {
      await fail(itemId, "needs-input", "no stored plan — replan required", "planning");
      return;
    }

    deps.emitEvent(itemId, { kind: "status", phase: "fetching" });
    let worktree: { path: string; branch: string };
    try {
      worktree = await deps.prepareWorktree(item, { refreshBase: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await fail(itemId, "needs-input", `worktree setup failed: ${message.slice(0, 500)}`, "queued");
      return;
    }
    deps.emitEvent(itemId, { kind: "status", phase: "worktree", detail: worktree.path });

    // Confinement baseline (#196): snapshot the checkout's dirty set now, so the
    // post-run tripwire can attribute only NEW dirt to this run.
    repoPath = deps.getRepoPath(item.repo);
    checkoutBefore = repoPath ? await deps.checkoutDirtyPaths(repoPath) : null;

    const repoSettings = deps.getRepoSettings(item.repo);
    const coderModel = repoSettings.coderModel;
    const { llm: repairProvider, runtime } = await resolveBundle(
      coderModel,
      repoSettings.coderRuntime,
    );
    // No agent runtime (openai, #238) — the coder cannot run. Park it for a
    // provider switch rather than crash the loop.
    if (!runtime) {
      await fail(
        itemId,
        "needs-input",
        `coding needs the ${repoSettings.coderRuntime} agent runtime — the selected provider has none`,
        "queued",
      );
      return;
    }

    // A previous run already worked in this worktree — its session may belong to
    // another runtime (#240), but the work it left on disk is still there.
    const priorSession =
      item.worktree?.sessionId !== undefined && item.worktree.path === worktree.path;
    // Resume only when the runtime can, its session was minted by this same runtime
    // (#238), and it belongs to this worktree path (cwd-scoped, #159).
    const resume =
      runtime.capabilities.resume &&
      sessionRuntimeOf(item.worktree) === runtime.id &&
      priorSession
        ? item.worktree!.sessionId
        : undefined;
    const sessionId = resume ?? randomUUID();
    // Persist before the long run — crash recovery resumes from this record.
    await deps.setWorktree(itemId, { ...worktree, sessionId, sessionRuntime: runtime.id });

    const cached = deps.getIssue(item);
    let comments: IssueComment[] = [];
    if (deps.fetchIssueComments) {
      try {
        comments = await deps.fetchIssueComments(item);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.emitEvent(itemId, {
          kind: "status",
          phase: "fetching",
          detail: `comment fetch failed — coding without comments: ${msg.slice(0, 200)}`,
        });
      }
    }
    const issue = {
      key: item.key,
      title: item.title,
      url: item.url,
      labels: cached?.labels ?? [],
      body: cached?.body,
      ...(comments.length > 0 ? { comments } : {}),
    };
    const settings = deps.getSettings();
    deps.emitEvent(itemId, { kind: "status", phase: resume ? "resuming" : "agent-start" });

    // Shepherd-driven PR fix round (#11) outranks reviewer objections (it is
    // the later stage); then reviewer-driven fix round (#10). Neither field is
    // cleared mid-run — pendingReviewComments clears on push (completePrOpen),
    // pendingObjections is replaced wholesale by the next completeReview — so a
    // crashed fix run re-delivers its fix prompt idempotently.
    const prComments = item.shepherd?.pendingReviewComments;
    const prFixMode = (prComments?.length ?? 0) > 0;
    const pending = item.review?.pendingObjections;
    const fixMode = !prFixMode && (pending?.length ?? 0) > 0;
    const freshPrompt = prFixMode
      ? buildPrFixPrompt(issue, prComments!)
      : fixMode
        ? buildFixPrompt(issue, pending!)
        : buildCoderPrompt(issue, stored.plan);
    const resumePrompt = prFixMode
      ? buildPrFixPrompt(issue, prComments!)
      : fixMode
        ? buildFixPrompt(issue, pending!)
        : buildResumePrompt(issue);
    // A fresh run over a worktree that already holds prior work (#240: the coder's
    // runtime changed, or its session died on disk) is seeded with a recap built
    // from durable artifacts. The fix prompts carry their own context already.
    const startPrompt = async (): Promise<string> =>
      prFixMode || fixMode || !priorSession
        ? freshPrompt
        : buildCoderRecapPrompt(issue, await collectRecap(item, worktree.path, stored.plan));

    const memory = deps.getMemoryMcp?.(item);
    // Confinement (#196): scope writes to the worktree, deny the checkout, protect
    // the user's home from out-of-root Bash paths (#278), and launch the guard hook
    // from the CLI bundle (reusing the memory wiring's path — present exactly when a
    // bundle exists). No bundle → L1 scoping + tripwire.
    const confinement: RunConfinement = {
      runRoot: worktree.path,
      denyRoots: repoPath ? [repoPath] : [],
      protectRoots: [homedir()],
      ...(memory?.cliBundlePath ? { cliBundlePath: memory.cliBundlePath } : {}),
    };
    // #227: inject the repo's conventions doc into the coder system prompt.
    // Best-effort — a read failure never blocks coding.
    const repoInstructions = await deps.getRepoInstructions(item.repo).catch(() => undefined);
    const baseOptions = {
      systemPrompt: withRepoConventions(CODER_SYSTEM_PROMPT, repoInstructions),
      cwd: worktree.path,
      model: coderModel,
      hardTimeoutMs: settings.coderTimeBudgetMin * 60_000,
      onEvent: (event: CodingEvent) => deps?.emitEvent(itemId, event),
      signal: controller.signal,
      confinement,
      ...(memory ? { memory } : {}),
    };

    let result: CodingRunResult | undefined;
    let sawEvent = false;
    const trackFirstEvent = (event: CodingEvent) => {
      sawEvent = true;
      baseOptions.onEvent(event);
    };
    // The session id the run actually used — salvage must resume THIS one, not the
    // minted id (a dead --resume retry mints a fresh session below).
    let runSessionId = resume ?? sessionId;
    // A budget/turns death (#194): salvaged for an honest final report, never
    // parked as "no result". null = the run finished (ok or a normal failure).
    let death: { kind: "hard_timeout" | "inactivity" | "max_turns" } | null = null;
    try {
      result = await runtime.runCoding({
        ...baseOptions,
        onEvent: trackFirstEvent,
        ...(resume
          ? { resumeSessionId: resume, prompt: resumePrompt }
          : { sessionId, prompt: await startPrompt() }),
      });
    } catch (err) {
      // A guard kill is checked BEFORE the dead-resume retry: it is not a dead
      // --resume, and its session on disk is what salvage must resume.
      if (err instanceof CodingTimeoutError) {
        death = { kind: err.kind };
      } else if (!resume || sawEvent || err instanceof CodingAbortError) {
        // A dead --resume (session gone from disk) fails fast without events:
        // retry once as a fresh session; other errors propagate.
        throw err;
      } else {
        const freshId = randomUUID();
        runSessionId = freshId;
        await deps.setWorktree(itemId, { ...worktree, sessionId: freshId, sessionRuntime: runtime.id });
        try {
          result = await runtime.runCoding({
            ...baseOptions,
            sessionId: freshId,
            prompt: await startPrompt(),
          });
        } catch (retryErr) {
          if (retryErr instanceof CodingTimeoutError) death = { kind: retryErr.kind };
          else throw retryErr;
        }
      }
    }

    // A max-turns backstop death lands as a non-ok result (not a throw) — salvage
    // it on the same path as a guard kill.
    if (!death && result && !result.ok && result.subtype === "error_max_turns") {
      death = { kind: "max_turns" };
    }

    // Salvage runs BEFORE the live()/tripwire checks below, so the one escape check
    // covers both the primary run's and the salvage run's dirt (#196). The wrap-up
    // resumes the dead session, so a runtime without resume goes straight to the
    // honest failure result (#238; dormant — claude-cli resumes).
    if (death) {
      if (!live()) return;
      if (!runtime.capabilities.resume) {
        result = { ok: false, summary: deathReason(death, settings), sessionId: runSessionId };
      } else {
        deps.emitEvent(itemId, {
          kind: "status",
          phase: "resuming",
          detail: "budget hit — salvaging final report",
        });
        try {
          result = await runtime.runCoding({
            ...baseOptions,
            resumeSessionId: runSessionId,
            prompt: buildCoderSalvagePrompt(),
            maxTurns: CODER_SALVAGE_MAX_TURNS,
            hardTimeoutMs: CODER_SALVAGE_HARD_TIMEOUT_MS,
          });
          // Salvage ran but the wrap-up itself failed — surface the honest reason.
          if (!result.ok) result = { ...result, summary: deathReason(death, settings) };
        } catch (err) {
          // Zombie rule (#159): a cancel during salvage dies silently.
          if (err instanceof CodingAbortError) throw err;
          // Salvage --resume fell over (e.g. no session on disk from a fresh run
          // killed before its init event) — fail honestly, never "no result".
          result = { ok: false, summary: deathReason(death, settings), sessionId: runSessionId };
        }
      }
    }

    // Unreachable: the primary run resolves, rethrows, or sets a death that the
    // salvage block always turns into a result. The guard only narrows the type.
    if (!result) throw new Error("coding run produced no result");

    // Cooperative cancel: the item may have been closed/moved mid-run, or an
    // untrack → re-admit may have superseded this run's token (#159).
    if (!live()) return;
    // Confinement tripwire (#196): if the run left new dirt in the linked
    // checkout, fail it — never land its diff as a normal review.
    const escaped = await checkoutEscaped(repoPath, checkoutBefore);
    if (escaped) {
      if (!live()) return;
      const reason = checkoutEscapeReason(escaped);
      deps.emitEvent(itemId, { kind: "error", message: reason });
      await fail(itemId, "failed", reason);
      return;
    }
    if (result.sessionId && result.sessionId !== sessionId) {
      await deps.setWorktree(itemId, {
        ...worktree,
        sessionId: result.sessionId,
        sessionRuntime: runtime.id,
      });
    }
    if (result.ok) {
      const raw = result.resultText ?? result.summary;
      let report: CoderReport | null = null;
      try {
        const first = tryParseCoderReport(raw);
        if (first.ok) {
          report = first.report;
        } else {
          report = await repairCoderReport(runtime, repairProvider, raw, first.error);
          // Repair awaited — the item may have moved or been superseded.
          if (!live()) return;
        }
      } catch {
        report = null; // never fail the run over report format
      }
      let ref: string | undefined;
      if (report) {
        ref = reportFileName(itemId);
        try {
          await writeStoredCoderReport(deps.plansDir, ref, {
            version: 1,
            itemId,
            repo: item.repo,
            issueKey: item.key,
            ...(item.number !== undefined ? { issueNumber: item.number } : {}),
            generatedAt: new Date().toISOString(),
            model: coderModel,
            report,
          });
        } catch {
          ref = undefined; // disk failure → degrade to a prose reason
          report = null;
        }
      }
      const reason = report
        ? `${report.done.length} file(s) done${
            report.deviations[0] ? ` — deviation: ${report.deviations[0]}` : ""
          }`.slice(0, 200)
        : result.summary.slice(0, 200) || "coding run completed";
      await deps.completeCoding(itemId, ref, reason, codingAt);
    } else {
      // After salvage the summary is already the honest death reason; "no result"
      // is only reachable for a non-budget failure with no summary or subtype.
      const detail =
        result.summary || (result.subtype ? `agent failed: ${result.subtype}` : "no result");
      await fail(itemId, "failed", `coding run failed: ${detail.slice(0, 500)}`);
    }
  } catch (err) {
    // A cancelled/superseded run dies silently — never park the (possibly fresh)
    // lifecycle on a zombie's failure (#159).
    if (!(err instanceof CodingAbortError) && live()) {
      // A run that both threw AND escaped its worktree is reported as the escape
      // (the more serious, actionable failure) (#196).
      const escaped = await checkoutEscaped(repoPath, checkoutBefore);
      if (escaped && live()) {
        const reason = checkoutEscapeReason(escaped);
        deps.emitEvent(itemId, { kind: "error", message: reason });
        await fail(itemId, "failed", reason);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await fail(itemId, "failed", `coding run failed: ${message.slice(0, 500)}`);
      }
    }
  } finally {
    inFlight.delete(itemId);
    release(repoKey);
    pokeCoder();
  }
}

/**
 * Durable prior-work context for a recap run (#240). Every source is best-effort:
 * the stored report, the pending feedback on the item and the worktree's dirty
 * set — never the previous run's transcript, which the other runtime owns.
 */
async function collectRecap(
  item: TrackedItem,
  worktreePath: string,
  plan: IssuePlan,
): Promise<CoderRecapInput> {
  const storedReport = item.coderReport?.ref
    ? await readStoredCoderReport(deps!.plansDir, item.coderReport.ref)
    : null;
  const dirty = await worktreeDirtyFiles(worktreePath).catch(() => null);
  const prComments = item.shepherd?.pendingReviewComments;
  const objections = item.review?.pendingObjections;
  return {
    plan,
    ...(storedReport ? { report: storedReport.report } : {}),
    ...(prComments?.length ? { prComments } : {}),
    ...(objections?.length ? { objections } : {}),
    ...(dirty?.length ? { dirtyPaths: porcelainPaths(dirty) } : {}),
  };
}

function release(repoKey: string): void {
  const count = activeRepos.get(repoKey) ?? 0;
  if (count <= 1) activeRepos.delete(repoKey);
  else activeRepos.set(repoKey, count - 1);
}

/** Honest failure reason for a budget death (#194) — the item's summary when even
 *  salvage couldn't produce a report, so the UI never shows "no result". */
function deathReason(
  death: { kind: "hard_timeout" | "inactivity" | "max_turns" },
  settings: OrchestratorSettings,
): string {
  switch (death.kind) {
    case "hard_timeout":
      return `hit the time budget (${settings.coderTimeBudgetMin} min)`;
    case "inactivity":
      return "produced no output for 10 minutes — killed as hung";
    case "max_turns":
      return `hit the max-turns backstop (${AGENT_MAX_TURNS_BACKSTOP})`;
  }
}

async function fail(
  itemId: string,
  to: LifecycleState,
  reason: string,
  resumeTo?: LifecycleState,
): Promise<void> {
  await deps
    ?.requestTransition(itemId, to, "coder", reason, resumeTo)
    .catch(() => {
      /* item moved concurrently — nothing to do */
    });
}

/**
 * Post-run tripwire (#196): the paths the run left newly dirty in the linked
 * checkout, or null when nothing new / the baseline or after-scan is unknown.
 */
async function checkoutEscaped(
  repoPath: string | undefined,
  before: string[] | null,
): Promise<string[] | null> {
  if (!deps || !repoPath || before === null) return null;
  const after = await deps.checkoutDirtyPaths(repoPath);
  if (after === null) return null;
  const escaped = newDirtyPaths(before, after);
  return escaped.length > 0 ? escaped : null;
}
