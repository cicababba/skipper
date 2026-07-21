import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodingEvent,
  ConfidenceReport,
  Issue,
  LlmSettings,
  OrchestratorSettings,
  RepoRef,
  ResolvedRepoOrchestratorSettings,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { DEFAULT_LLM_SETTINGS, DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/shared";
import { AgentAbortError, computeConfidence } from "@skipper/core";
import { initRescore, startRescore, cancelRescore, type RescoreDeps } from "./rescore";
import { readStoredPlan, writeStoredPlan } from "./plan-store";

type Compute = typeof computeConfidence;

const REF = "github_1.json";
const GENERATED_AT = "2026-07-21T00:00:00.000Z";
const EDITED_AT = "2026-07-21T01:00:00.000Z";

const PLAN = {
  summary: "amended",
  context: [],
  files: [{ path: "src/a.ts", reason: "hosts the change" }],
  steps: [{ title: "edit", detail: "do it", files: ["src/a.ts"], symbols: ["run"] }],
  outOfScope: [],
  acceptance: [{ criterion: "works", addressedBy: "the edit" }],
  risks: [],
  verificationCommands: [],
  manualChecks: [],
  openQuestions: [],
  estimatedSize: "s",
} as StoredPlan["plan"];

function makeReport(composite: number, empty = false): ConfidenceReport {
  return {
    version: 1,
    composite,
    weights: { groundedness: 0.5, convergence: 0, critic: 0.4, clarity: 0.1 },
    signals: empty
      ? {}
      : { critic: { score: composite, verdict: "approve", objections: [] } },
    convergenceSkipped: { reason: "rescore", detail: "d" },
    errors: [],
    computedAt: EDITED_AT,
  };
}

function makeItem(over: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "owner/repo", key: "1" },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "owner", name: "repo" },
    key: "1",
    number: 1,
    title: "issue 1",
    url: "https://github.com/owner/repo/issues/1",
    state: "plan-gate",
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    transitions: [],
    plan: { ref: REF, sessionId: "sess-1" },
    worktree: { path: "/wt/issue-1", branch: "feature/issue-1" },
    ...over,
  } as TrackedItem;
}

interface Harness {
  deps: RescoreDeps;
  items: Map<string, TrackedItem>;
  events: CodingEvent[];
  log: string[];
  completeCalls: { itemId: string; composite?: number }[];
  waitComplete: () => Promise<{ itemId: string; composite?: number }>;
}

function makeHarness(plansDir: string, item: TrackedItem, compute: Compute): Harness {
  const items = new Map<string, TrackedItem>([[item.id, item]]);
  const events: CodingEvent[] = [];
  const log: string[] = [];
  const completeCalls: { itemId: string; composite?: number }[] = [];
  const resolvers: ((v: { itemId: string; composite?: number }) => void)[] = [];
  const pending: { itemId: string; composite?: number }[] = [];

  const deps: RescoreDeps = {
    getItem: (id) => items.get(id),
    getIssue: () => ({ labels: [], body: "the body" }) as unknown as Issue,
    getRepoPath: (_repo: RepoRef) => "/repo",
    getRepoSettings: () =>
      ({ plannerModel: "opus", autoCoding: "auto" }) as unknown as ResolvedRepoOrchestratorSettings,
    getSettings: (): OrchestratorSettings => DEFAULT_ORCHESTRATOR_SETTINGS,
    getLlmSettings: async (): Promise<LlmSettings> => ({ ...DEFAULT_LLM_SETTINGS }),
    emitEvent: (_id, e) => events.push(e),
    plansDir,
    setPlanRescoring: async (id) => {
      log.push("rescoring");
      const it = items.get(id);
      if (it) it.plan = { ...it.plan, rescoring: true };
    },
    completeRescore: async (id, composite) => {
      completeCalls.push({ itemId: id, composite });
      const it = items.get(id);
      if (it) {
        const { rescoring: _drop, ...plan } = it.plan ?? {};
        const setC = composite !== undefined && it.state === "plan-gate";
        it.plan = setC ? { ...plan, confidence: composite } : plan;
      }
      const payload = { itemId: id, composite };
      const r = resolvers.shift();
      if (r) r(payload);
      else pending.push(payload);
    },
    computeConfidence: ((opts: Parameters<Compute>[0]) => {
      log.push("compute");
      return compute(opts);
    }) as Compute,
  };

  const waitComplete = () =>
    pending.length > 0
      ? Promise.resolve(pending.shift()!)
      : new Promise<{ itemId: string; composite?: number }>((res) => resolvers.push(res));

  return { deps, items, events, log, completeCalls, waitComplete };
}

async function seedPlan(plansDir: string, over: Partial<StoredPlan> = {}): Promise<StoredPlan> {
  const stored: StoredPlan = {
    version: 2,
    itemId: "github:1",
    repo: { owner: "owner", name: "repo" },
    generatedAt: GENERATED_AT,
    model: "opus",
    plan: PLAN,
    editedAt: EDITED_AT,
    ...over,
  };
  await writeStoredPlan(plansDir, REF, stored);
  return stored;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let plansDir: string;
beforeEach(async () => {
  plansDir = await mkdtemp(join(tmpdir(), "nb-rescore-"));
});
afterEach(async () => {
  await rm(plansDir, { recursive: true, force: true });
});

describe("startRescore happy path", () => {
  it("writes the fresh confidence and completes with its composite", async () => {
    const report = makeReport(0.9);
    const applied = await seedPlan(plansDir);
    const h = makeHarness(plansDir, makeItem(), async () => report);
    initRescore(h.deps);

    startRescore("github:1", applied);
    const done = await h.waitComplete();

    expect(done.composite).toBe(0.9);
    const onDisk = await readStoredPlan(plansDir, REF);
    expect(onDisk?.confidence).toEqual(report);
    // Plan content is preserved (re-read-then-spread never clobbers it).
    expect(onDisk?.plan.summary).toBe("amended");
    // Flag is cleared and the composite landed on the item.
    expect(h.items.get("github:1")?.plan?.rescoring).toBeUndefined();
    expect(h.items.get("github:1")?.plan?.confidence).toBe(0.9);
  });

  it("marks the item rescoring before it scores", async () => {
    const applied = await seedPlan(plansDir);
    const h = makeHarness(plansDir, makeItem(), async () => makeReport(0.8));
    initRescore(h.deps);

    startRescore("github:1", applied);
    await h.waitComplete();

    expect(h.log.indexOf("rescoring")).toBeLessThan(h.log.indexOf("compute"));
    expect(h.log.indexOf("rescoring")).toBeGreaterThanOrEqual(0);
  });
});

describe("startRescore liveness", () => {
  it("aborts mid-score: no write, flag cleared, no composite", async () => {
    const applied = await seedPlan(plansDir);
    const h = makeHarness(
      plansDir,
      makeItem(),
      (opts) =>
        new Promise<ConfidenceReport>((_res, rej) => {
          const sig = opts.signal!;
          if (sig.aborted) rej(new AgentAbortError());
          else sig.addEventListener("abort", () => rej(new AgentAbortError()));
        }),
    );
    initRescore(h.deps);

    startRescore("github:1", applied);
    // Let the run reach compute (behind the async deps) before aborting.
    await Promise.resolve();
    await Promise.resolve();
    cancelRescore("github:1");
    const done = await h.waitComplete();

    expect(done.composite).toBeUndefined();
    expect((await readStoredPlan(plansDir, REF))?.confidence).toBeUndefined();
    expect(h.items.get("github:1")?.plan?.rescoring).toBeUndefined();
  });

  it("refuses to land when the item left plan-gate", async () => {
    const applied = await seedPlan(plansDir);
    const gate = deferred<ConfidenceReport>();
    const h = makeHarness(plansDir, makeItem(), () => gate.promise);
    initRescore(h.deps);

    startRescore("github:1", applied);
    await Promise.resolve();
    // Move the item out of the gate before scoring resolves.
    h.items.get("github:1")!.state = "queued";
    gate.resolve(makeReport(0.9));
    const done = await h.waitComplete();

    expect(done.composite).toBeUndefined();
    expect((await readStoredPlan(plansDir, REF))?.confidence).toBeUndefined();
  });

  it("refuses to land when the plan was edited under it", async () => {
    const applied = await seedPlan(plansDir);
    const gate = deferred<ConfidenceReport>();
    const h = makeHarness(plansDir, makeItem(), () => gate.promise);
    initRescore(h.deps);

    startRescore("github:1", applied);
    await Promise.resolve();
    // A later edit re-stamps editedAt on disk — the run's token no longer matches.
    await seedPlan(plansDir, { editedAt: "2026-07-21T02:00:00.000Z" });
    gate.resolve(makeReport(0.9));
    const done = await h.waitComplete();

    expect(done.composite).toBeUndefined();
    const onDisk = await readStoredPlan(plansDir, REF);
    expect(onDisk?.confidence).toBeUndefined();
    expect(onDisk?.editedAt).toBe("2026-07-21T02:00:00.000Z");
  });

  it("treats an empty-signals report as no score: plan untouched, flag cleared", async () => {
    const applied = await seedPlan(plansDir);
    const h = makeHarness(plansDir, makeItem(), async () => makeReport(0, true));
    initRescore(h.deps);

    startRescore("github:1", applied);
    const done = await h.waitComplete();

    expect(done.composite).toBeUndefined();
    expect((await readStoredPlan(plansDir, REF))?.confidence).toBeUndefined();
    expect(h.items.get("github:1")?.plan?.rescoring).toBeUndefined();
  });
});

describe("startRescore concurrency", () => {
  it("a second start aborts the first and only the second lands", async () => {
    const applied = await seedPlan(plansDir);
    const compute = vi
      .fn<Compute>()
      .mockImplementationOnce(
        (opts) =>
          new Promise<ConfidenceReport>((_res, rej) => {
            const sig = opts.signal!;
            if (sig.aborted) rej(new AgentAbortError());
            else sig.addEventListener("abort", () => rej(new AgentAbortError()));
          }),
      )
      .mockImplementationOnce(async () => makeReport(0.77));
    const h = makeHarness(plansDir, makeItem(), compute as unknown as Compute);
    initRescore(h.deps);

    startRescore("github:1", applied);
    await Promise.resolve();
    startRescore("github:1", applied);
    const done = await h.waitComplete();

    expect(done.composite).toBe(0.77);
    // The first run's signal was aborted by the second start.
    expect((compute.mock.calls[0][0] as Parameters<Compute>[0]).signal!.aborted).toBe(true);
    // Exactly one completion (the superseded run never completes).
    expect(h.completeCalls).toHaveLength(1);
    expect((await readStoredPlan(plansDir, REF))?.confidence?.composite).toBe(0.77);
  });
});
