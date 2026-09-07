import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_RUNTIME_IDS,
  DEFAULT_EXTRA_PLAN_RUNS,
  DEFAULT_LLM_SETTINGS,
  type AgentRuntimeId,
  type ConfidenceReport,
  type IssuePlan,
  type LlmSettings,
} from "@skipper/shared";
import {
  DEFAULT_CONFIDENCE_WEIGHTS,
  GROUNDEDNESS_VETO,
  buildCalibrationRows,
  compositeOf,
  createProvider,
  createRuntime,
  critiquePlan,
  findIncompleteSamples,
  generatePlan,
  loadOrCreateOrchestratorManifest,
  overridePlannerPair,
  planDigest,
  porcelainPaths,
  renderCalibrationReport,
  renderIncompleteWarning,
  renderPlannerPairBanner,
  resolvePlannerPair,
  scoreClarity,
  scoreConvergence,
  scoreGroundedness,
  summarizePlannerPairs,
  type AgentRuntime,
  type CalibrationLabel,
  type CalibrationSample,
  type LLMProviderInterface,
  type PlanIssueInput,
  type PlannerPair,
  type PlannerPairSources,
  worktreeDirtyError,
} from "@skipper/core";

// Threshold-calibration harness (#314). Collects real plan runs and scores their
// four confidence signals, keeping every raw judgment so a later curve or weight
// change can be replayed offline. Deliberately does not call computeConfidence —
// see the note atop packages/core/src/confidence/calibration.ts.

// Injected by scripts/build-calibrate.mjs, so the line describes the code that is
// actually inside this bundle: a stale bundle run by hand reports its own old sha
// instead of silently borrowing today's.
declare const __CALIBRATE_CODE_SHA__: string;
declare const __CALIBRATE_CODE_DIRTY__: boolean;

const CODE_PROVENANCE = { sha: __CALIBRATE_CODE_SHA__, dirty: __CALIBRATE_CODE_DIRTY__ };

const SCRIPTS_DIR = join(__dirname, "..");
const CALIBRATION_DIR = join(SCRIPTS_DIR, "calibration");
const RUNS_DIR = join(CALIBRATION_DIR, "runs");

/** A corpus body still waiting to be pasted in (the Jira samples). */
const PLACEHOLDER_PREFIX = "TODO:";
const PLAN_HARD_TIMEOUT_MS = 15 * 60_000;
/** Mirrors the planner's bundle (apps/desktop/src/planner.ts resolveBundle). */
const BUNDLE_MAX_TURNS = 5;
const GIT_TIMEOUT_MS = 180_000;

interface CorpusEntry {
  id: string;
  repo: string;
  repoPath: string;
  baseRef: string;
  provenance: string;
  issue: PlanIssueInput;
}

interface Corpus {
  samples: CorpusEntry[];
}

interface Options {
  mode: "collect" | "analyze";
  only?: string[];
  concurrency: number;
  /** Absent = mirror the app's planner-pair resolution per sample repo. */
  model?: string;
  runtime?: AgentRuntimeId;
  runId?: string;
  keepWorktrees: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    mode: "collect",
    concurrency: 2,
    keepWorktrees: false,
    dryRun: false,
  };
  // `pnpm calibrate -- --dry-run` forwards the separator verbatim.
  const rest = argv.filter((a) => a !== "--");
  if (rest[0] === "collect" || rest[0] === "analyze") {
    opts.mode = rest.shift() as Options["mode"];
  }
  while (rest.length > 0) {
    const flag = rest.shift()!;
    switch (flag) {
      case "--only":
        opts.only = (rest.shift() ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, Number.parseInt(rest.shift() ?? "2", 10) || 2);
        break;
      case "--model":
        opts.model = rest.shift() ?? DEFAULT_LLM_SETTINGS.claudeModel;
        break;
      case "--runtime": {
        const id = rest.shift() ?? "";
        if (!AGENT_RUNTIME_IDS.includes(id as AgentRuntimeId)) {
          throw new Error(`unknown runtime: ${id} (expected one of ${AGENT_RUNTIME_IDS.join(", ")})`);
        }
        opts.runtime = id as AgentRuntimeId;
        break;
      }
      case "--run":
        opts.runId = rest.shift();
        break;
      case "--keep-worktrees":
        opts.keepWorktrees = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return opts;
}

function git(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(err) });
    });
  });
}

async function addWorktree(repoPath: string, worktreePath: string, ref: string): Promise<void> {
  const resolved = await git(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (resolved.code !== 0) {
    throw new Error(`base ref ${ref} not found in ${repoPath} — fetch it first`);
  }
  await git(repoPath, ["worktree", "prune"]);
  const added = await git(repoPath, ["worktree", "add", "--detach", "--force", worktreePath, ref]);
  if (added.code !== 0) {
    throw new Error(`git worktree add --detach failed: ${added.stderr.trim() || `exit ${added.code}`}`);
  }
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]);
  await git(repoPath, ["worktree", "prune"]);
}

/** Dirty paths a run left behind, then restore so the next sample starts at base. */
async function checkAndRestore(worktreePath: string): Promise<string[]> {
  const status = await git(worktreePath, ["status", "--porcelain"]);
  const paths = porcelainPaths(status.stdout);
  if (paths.length === 0) return [];
  await git(worktreePath, ["checkout", "--", "."]);
  await git(worktreePath, ["clean", "-fd"]);
  return paths;
}

function userDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Skipper");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Skipper");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Skipper");
}

/**
 * Mirrors getLlmSettingsDir in apps/desktop/src/main.ts: the dev build reads
 * <repo>/data/settings.json, the packaged one reads userData. The harness cannot
 * know which build the user runs, so it prefers the dev file when it exists and
 * prints whichever one it read.
 */
async function readClaudeModel(): Promise<{ claudeModel: string; settingsFile?: string }> {
  const candidates = [
    join(SCRIPTS_DIR, "..", "data", "settings.json"),
    join(userDataDir(), "settings.json"),
  ];
  for (const file of candidates) {
    try {
      const saved = JSON.parse(await readFile(file, "utf-8")) as { llm?: Partial<LlmSettings> };
      const merged: LlmSettings = { ...DEFAULT_LLM_SETTINGS, ...saved.llm };
      return { claudeModel: merged.claudeModel, settingsFile: file };
    } catch {
      continue;
    }
  }
  return { claudeModel: DEFAULT_LLM_SETTINGS.claudeModel };
}

interface PairResolution {
  byRepo: Map<string, PlannerPair>;
  claudeModel: string;
  /** The pair banner, which shouts on its own when the corpus mixes pairs. */
  banner: string;
}

interface Bundle {
  llm: LLMProviderInterface;
  runtime: AgentRuntime;
  model: string;
}

/** Mirrors buildLlm in apps/desktop/src/llm-settings.ts: the completions provider
 *  stays on claude-cli and must never see another vendor's model string. */
function buildBundle(pair: PlannerPair, claudeModel: string): Bundle {
  const llm = createProvider({
    provider: "claude-cli",
    model: pair.runtime === "claude-cli" ? pair.model : claudeModel,
    maxTurns: BUNDLE_MAX_TURNS,
  });
  const runtime = createRuntime({
    provider: "claude-cli",
    model: pair.model,
    maxTurns: BUNDLE_MAX_TURNS,
    runtime: pair.runtime,
  });
  if (!runtime) throw new Error(`${pair.runtime} runtime unavailable`);
  return { llm, runtime, model: pair.model };
}

/**
 * The pair every plan run of this corpus will use. The manifest always lives in
 * userData — the dev split applies to settings.json only.
 */
async function resolvePairs(entries: CorpusEntry[], opts: Options): Promise<PairResolution> {
  const { claudeModel, settingsFile } = await readClaudeModel();
  const manifestFile = join(userDataDir(), "orchestrator-manifest.json");
  const manifest = await loadOrCreateOrchestratorManifest(manifestFile);
  const sources: PlannerPairSources = {
    claudeModel,
    ...(settingsFile ? { settingsFile } : {}),
    ...((await exists(manifestFile)) ? { manifestFile } : {}),
  };

  const byRepo = new Map<string, PlannerPair>();
  for (const entry of entries) {
    if (byRepo.has(entry.repo)) continue;
    const resolved = resolvePlannerPair(entry.repo, {
      settings: manifest.settings,
      repoSettings: manifest.repoSettings,
      claudeModel,
    });
    byRepo.set(
      entry.repo,
      overridePlannerPair(
        resolved,
        {
          ...(opts.runtime ? { runtime: opts.runtime } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        },
        claudeModel,
      ),
    );
  }

  const summary = summarizePlannerPairs(
    entries.map((e) => ({ repo: e.repo, pair: byRepo.get(e.repo)! })),
  );
  return { byRepo, claudeModel, banner: renderPlannerPairBanner(summary, sources) };
}

async function readRepoInstructions(repoKey: string): Promise<string | undefined> {
  const file = join(
    userDataDir(),
    "repo-instructions",
    `${repoKey.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
  );
  try {
    const doc = JSON.parse(await readFile(file, "utf-8")) as { content?: string; status?: string };
    return doc.status === "ready" && doc.content ? doc.content : undefined;
  } catch {
    return undefined;
  }
}

async function loadCorpus(): Promise<CorpusEntry[]> {
  const raw = await readFile(join(CALIBRATION_DIR, "samples.json"), "utf-8");
  return (JSON.parse(raw) as Corpus).samples;
}

function selectEntries(entries: CorpusEntry[], only?: string[]): CorpusEntry[] {
  if (!only || only.length === 0) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  return only.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`unknown sample id: ${id}`);
    return entry;
  });
}

function assertRunnable(entries: CorpusEntry[]): void {
  const pending = entries.filter((e) => (e.issue.body ?? "").trim().startsWith(PLACEHOLDER_PREFIX));
  if (pending.length > 0) {
    throw new Error(
      `these samples still carry a placeholder body — paste the real issue text into scripts/calibration/samples.json first: ${pending
        .map((e) => e.id)
        .join(", ")}`,
    );
  }
}

function runStamp(): string {
  const iso = new Date().toISOString();
  return `run-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface CollectContext {
  llm: LLMProviderInterface;
  runtime: AgentRuntime;
  model: string;
  worktree: string;
  repoInstructions?: string;
}

async function collectSample(
  entry: CorpusEntry,
  ctx: CollectContext,
): Promise<{ sample: CalibrationSample; plans: IssuePlan[] }> {
  const startedAt = Date.now();
  const confinement = { runRoot: ctx.worktree, denyRoots: [entry.repoPath] };
  const planOpts = {
    issue: entry.issue,
    repoPath: ctx.worktree,
    llm: ctx.llm,
    runtime: ctx.runtime,
    hardTimeoutMs: PLAN_HARD_TIMEOUT_MS,
    confinement,
    ...(ctx.repoInstructions ? { repoInstructions: ctx.repoInstructions } : {}),
  };

  const planStartedAt = Date.now();
  const primary = await generatePlan(planOpts);
  const planMs = Date.now() - planStartedAt;

  const extraStartedAt = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: DEFAULT_EXTRA_PLAN_RUNS }, () => generatePlan(planOpts)),
  );
  const extraPlansMs = Date.now() - extraStartedAt;
  const errors: string[] = [];
  const extra = settled
    .filter((r): r is PromiseFulfilledResult<IssuePlan> => r.status === "fulfilled")
    .map((r) => r.value);
  if (extra.length < settled.length) {
    errors.push(`convergence: ${settled.length - extra.length}/${settled.length} extra plan runs failed`);
  }

  const scoringStartedAt = Date.now();
  const signals: CalibrationSample["signals"] = {};
  await Promise.all([
    scoreGroundedness(primary, ctx.worktree)
      .then((s) => void (signals.groundedness = s))
      .catch((err) => void errors.push(`groundedness: ${errorMessage(err)}`)),
    critiquePlan(primary, entry.issue, ctx.llm, {
      repoPath: ctx.worktree,
      runtime: ctx.runtime,
      onDegraded: (reason) => void errors.push(`critic: ${reason}`),
    })
      .then((s) => void (signals.critic = s))
      .catch((err) => void errors.push(`critic: ${errorMessage(err)}`)),
    scoreClarity(entry.issue, primary, ctx.llm, { runtime: ctx.runtime })
      .then((s) => void (signals.clarity = s))
      .catch((err) => void errors.push(`clarity: ${errorMessage(err)}`)),
    (async () => {
      if (extra.length === 0) {
        errors.push("convergence: no extra plan to compare against");
        return;
      }
      try {
        signals.convergence = scoreConvergence([primary, ...extra]);
      } catch (err) {
        errors.push(`convergence: ${errorMessage(err)}`);
      }
    })(),
  ]);
  const scoringMs = Date.now() - scoringStartedAt;

  const scores = {
    ...(signals.groundedness ? { groundedness: signals.groundedness.score } : {}),
    ...(signals.critic ? { critic: signals.critic.score } : {}),
    ...(signals.clarity ? { clarity: signals.clarity.score } : {}),
    ...(signals.convergence ? { convergence: signals.convergence.score } : {}),
  };

  const coverage = signals.groundedness?.coverage;
  const veto: ConfidenceReport["veto"] =
    coverage !== undefined && coverage < GROUNDEDNESS_VETO
      ? {
          signal: "groundedness",
          detail: `${signals.groundedness!.missingFiles.length} cited files and ${signals.groundedness!.missingSymbols.length} symbols are absent from the repo`,
        }
      : undefined;

  const sample: CalibrationSample = {
    version: 1,
    id: entry.id,
    repo: entry.repo,
    provenance: entry.provenance,
    issueKey: entry.issue.key,
    issueTitle: entry.issue.title,
    issueUrl: entry.issue.url,
    plan: planDigest(primary),
    signals,
    composite: compositeOf(scores, DEFAULT_CONFIDENCE_WEIGHTS),
    weights: DEFAULT_CONFIDENCE_WEIGHTS,
    ...(veto ? { veto } : {}),
    runtime: ctx.runtime.id,
    model: ctx.model,
    graphify: false,
    timings: { planMs, extraPlansMs, scoringMs, totalMs: Date.now() - startedAt },
    errors,
    collectedAt: new Date().toISOString(),
  };
  return { sample, plans: [primary, ...extra] };
}

async function collect(opts: Options): Promise<void> {
  const entries = selectEntries(await loadCorpus(), opts.only);
  const pairs = await resolvePairs(entries, opts);
  console.log(pairs.banner);
  console.log("");
  if (opts.dryRun) {
    console.log(`${entries.length} sample(s) planned:`);
    for (const e of entries) {
      const placeholder = (e.issue.body ?? "").trim().startsWith(PLACEHOLDER_PREFIX);
      console.log(
        `  ${e.id}  ${e.repo}@${e.baseRef}  ${e.issue.key} ${e.issue.title}${placeholder ? "  [PLACEHOLDER BODY — not runnable]" : ""}`,
      );
    }
    return;
  }
  assertRunnable(entries);

  const runId = opts.runId ?? runStamp();
  const outDir = join(RUNS_DIR, runId);
  const plansDir = join(outDir, "plans");
  await mkdir(plansDir, { recursive: true });
  console.log(`run ${runId} → ${outDir}`);

  const bundles = new Map<string, Bundle>();
  const bundleFor = (pair: PlannerPair): Bundle => {
    const key = `${pair.runtime}:${pair.model}`;
    const cached = bundles.get(key);
    if (cached) return cached;
    const bundle = buildBundle(pair, pairs.claudeModel);
    bundles.set(key, bundle);
    return bundle;
  };

  const worktrees = new Map<string, { repoPath: string; path: string }>();
  const instructions = new Map<string, string | undefined>();
  try {
    for (const entry of entries) {
      if (!worktrees.has(entry.repo)) {
        const path = join(tmpdir(), `skipper-calibration-${runId}`, entry.repo.replace(/[^A-Za-z0-9._-]/g, "_"));
        await addWorktree(entry.repoPath, path, entry.baseRef);
        worktrees.set(entry.repo, { repoPath: entry.repoPath, path });
        console.log(`worktree ${entry.repo}@${entry.baseRef} → ${path}`);
      }
      if (!instructions.has(entry.repo)) {
        instructions.set(entry.repo, await readRepoInstructions(entry.repo));
      }
    }

    await runPool(entries, opts.concurrency, async (entry) => {
      const resultPath = join(outDir, `${entry.id}.json`);
      if (await exists(resultPath)) {
        console.log(`skip ${entry.id} — already collected`);
        return;
      }
      const started = Date.now();
      const worktree = worktrees.get(entry.repo)!.path;
      console.log(`start ${entry.id}`);
      try {
        const bundle = bundleFor(pairs.byRepo.get(entry.repo)!);
        const { sample, plans } = await collectSample(entry, {
          llm: bundle.llm,
          runtime: bundle.runtime,
          model: bundle.model,
          worktree,
          ...(instructions.get(entry.repo) ? { repoInstructions: instructions.get(entry.repo)! } : {}),
        });
        const dirty = await checkAndRestore(worktree);
        if (dirty.length > 0) sample.errors.push(worktreeDirtyError(dirty));
        await writeFile(resultPath, `${JSON.stringify(sample, null, 2)}\n`, "utf-8");
        await writeFile(
          join(plansDir, `${entry.id}.json`),
          `${JSON.stringify(plans, null, 2)}\n`,
          "utf-8",
        );
        console.log(
          `done  ${entry.id} — composite ${sample.composite.toFixed(3)}${sample.veto ? " (VETO)" : ""} in ${Math.round((Date.now() - started) / 1000)}s`,
        );
      } catch (err) {
        console.error(`FAIL  ${entry.id}: ${errorMessage(err)}`);
        const dirty = await checkAndRestore(worktree);
        if (dirty.length > 0) console.error(`      ${worktreeDirtyError(dirty)}`);
      }
    });
  } finally {
    if (opts.keepWorktrees) {
      for (const wt of worktrees.values()) console.log(`kept worktree ${wt.path}`);
    } else {
      for (const wt of worktrees.values()) await removeWorktree(wt.repoPath, wt.path);
    }
  }
  const warning = renderIncompleteWarning(findIncompleteSamples(await readSamples(outDir)), outDir);
  if (warning) console.warn(`\n${warning}`);
  console.log(`\nnext: label ${join(outDir, "labels.json")}, then run: pnpm calibrate -- analyze --run ${runId}`);
}

async function readSamples(outDir: string): Promise<CalibrationSample[]> {
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".json") && f !== "labels.json");
  const samples: CalibrationSample[] = [];
  for (const file of files.sort()) {
    samples.push(JSON.parse(await readFile(join(outDir, file), "utf-8")) as CalibrationSample);
  }
  return samples;
}

async function analyze(opts: Options): Promise<void> {
  if (!opts.runId) throw new Error("analyze needs --run <id>");
  const outDir = join(RUNS_DIR, opts.runId);
  const samples = await readSamples(outDir);
  if (samples.length === 0) throw new Error(`no samples in ${outDir}`);

  let labels: Record<string, CalibrationLabel> = {};
  try {
    labels = JSON.parse(await readFile(join(outDir, "labels.json"), "utf-8"));
  } catch {
    console.log("no labels.json — rendering with empty label cells");
  }

  const rows = buildCalibrationRows(samples, labels, DEFAULT_CONFIDENCE_WEIGHTS);
  const first = samples[0];
  const report = renderCalibrationReport(rows, {
    runId: opts.runId,
    runtime: first.runtime,
    model: first.model,
    graphify: first.graphify,
    weights: DEFAULT_CONFIDENCE_WEIGHTS,
    code: CODE_PROVENANCE,
    generatedAt: new Date().toISOString(),
  });
  const reportPath = join(outDir, "report.md");
  await writeFile(reportPath, `${report}\n`, "utf-8");
  console.log(report);
  const stale = rows.filter((r) => r.fallbacks.length > 0);
  if (stale.length > 0) {
    console.log(`\n${stale.length} sample(s) replayed from a stored score — see the report.`);
  }
  console.log(`\nwrote ${reportPath}`);
}

async function main(): Promise<void> {
  console.log(`[calibrate] code ${CODE_PROVENANCE.sha}${CODE_PROVENANCE.dirty ? " (dirty)" : ""}`);
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === "analyze") await analyze(opts);
  else await collect(opts);
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exitCode = 1;
});
