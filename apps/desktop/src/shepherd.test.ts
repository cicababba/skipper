import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleState, PrReviewComment, SolutionRecord, TrackedItem } from "@skipper/shared";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  memoryFileName,
  registerTransformersLoader,
  searchMemory,
  type DistillInput,
  type OrchestratorSettings,
} from "@skipper/core";
import { initShepherd, openOrPushPr, pokeShepherd, type ShepherdDeps } from "./shepherd";
import {
  commitWorktree,
  pushWorktreeBranch,
  captureBranchDiff,
  deleteBranchForce,
  removeWorktree,
} from "./worktrees";

vi.mock("./worktrees", () => ({
  commitWorktree: vi.fn(async () => ({ committed: true, sha: "abc123" })),
  pushWorktreeBranch: vi.fn(async () => undefined),
  captureBranchDiff: vi.fn(async () => ({
    diff: "+line",
    stats: { filesChanged: 1, totalChangedLines: 1, files: ["new.txt"] },
  })),
  removeWorktree: vi.fn(async () => undefined),
  deleteBranchForce: vi.fn(async () => true),
}));

// Deterministic bag-of-words embedder (core's memory.test.ts pattern): the
// distillation path indexes the rewritten record, and no test may download a model.
function vecFor(text: string): number[] {
  const v = new Array(32).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    v[h % 32] += 1;
  }
  const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0)) || 1;
  return v.map((x: number) => x / norm);
}

beforeAll(() => {
  registerTransformersLoader(() => ({
    pipeline: async () => async (text: string) => ({ tolist: () => [vecFor(text)] }),
  }));
});

const commitMock = vi.mocked(commitWorktree);
const pushMock = vi.mocked(pushWorktreeBranch);
const captureMock = vi.mocked(captureBranchDiff);
const removeMock = vi.mocked(removeWorktree);
const deleteBranchMock = vi.mocked(deleteBranchForce);

let memoryDir: string;

function makeItem(n: number, state: LifecycleState, extra: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: `github:${n}`,
    source: "github",
    sourceRef: { project: "owner/repo", key: String(n) },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "owner", name: "repo" },
    key: String(n),
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/owner/repo/issues/${n}`,
    state,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    transitions: [],
    worktree: { path: `/wt/repo/issue-${n}`, branch: `feature/issue-${n}`, sessionId: "s" },
    ...extra,
  };
}

interface Harness {
  items: Map<string, TrackedItem>;
  deps: ShepherdDeps;
  prOpens: Array<{ itemId: string; pr: { id: string; number: number; url: string }; sha: string; actor: string; reason: string }>;
  reentries: Array<{ itemId: string; comments: PrReviewComment[] }>;
  cleanups: Array<{ itemId: string; memoryRef: string }>;
  transitions: Array<{
    itemId: string;
    to: LifecycleState;
    actor: string;
    reason?: string;
    resumeTo?: LifecycleState;
  }>;
}

function makeHarness(overrides: Partial<ShepherdDeps> = {}): Harness {
  const items = new Map<string, TrackedItem>();
  const prOpens: Harness["prOpens"] = [];
  const reentries: Harness["reentries"] = [];
  const cleanups: Harness["cleanups"] = [];
  const transitions: Harness["transitions"] = [];
  const deps: ShepherdDeps = {
    listItems: () => [...items.values()],
    getItem: (id) => items.get(id),
    getSettings: () => DEFAULT_ORCHESTRATOR_SETTINGS as OrchestratorSettings,
    getTokenProvider: () => async () => "tok",
    getBaseUrl: () => undefined,
    getRepoPath: () => "/repos/repo",
    getBaseBranch: async () => "develop",
    getPlan: async () => null,
    requestTransition: async (itemId, to, actor, reason, resumeTo) => {
      transitions.push({ itemId, to, actor, reason, resumeTo });
      const item = items.get(itemId)!;
      const next = { ...item, state: to };
      items.set(itemId, next);
      return next;
    },
    completePrOpen: async (itemId, pr, sha, actor, reason) => {
      prOpens.push({ itemId, pr, sha, actor, reason });
      const item = items.get(itemId)!;
      items.set(itemId, {
        ...item,
        state: "pr-open",
        pr,
        shepherd: { ...item.shepherd, pendingReviewComments: undefined, lastPushedSha: sha },
      });
    },
    completeReentry: async (itemId, comments) => {
      reentries.push({ itemId, comments });
      const item = items.get(itemId)!;
      items.set(itemId, {
        ...item,
        state: "coding",
        shepherd: { ...item.shepherd, pendingReviewComments: comments },
      });
    },
    completeMergedCleanup: async (itemId, memoryRef) => {
      cleanups.push({ itemId, memoryRef });
      const item = items.get(itemId)!;
      items.set(itemId, { ...item, worktree: undefined, shepherd: { ...item.shepherd, memoryRef } });
    },
    memoryDir,
    ...overrides,
  };
  return { items, deps, prOpens, reentries, cleanups, transitions };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function settle(): Promise<void> {
  // Real fs I/O (memory-store writes) rides the threadpool — spin on time, not setImmediate.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "nb-memory-"));
  commitMock.mockClear();
  pushMock.mockClear();
  captureMock.mockClear();
  removeMock.mockClear();
  deleteBranchMock.mockClear();
  deleteBranchMock.mockResolvedValue(true);
  commitMock.mockResolvedValue({ committed: true, sha: "abc123" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(memoryDir, { recursive: true, force: true });
});

describe("openOrPushPr", () => {
  it("rejects items not in human-review and unknown items", async () => {
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "coding"));
    expect(await openOrPushPr("github:1", "user")).toMatchObject({ ok: false });
    expect(await openOrPushPr("github:404", "user")).toMatchObject({ ok: false });
    expect(h.prOpens).toEqual([]);
  });

  it("commits, pushes and opens a draft PR, writing the authoritative link", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse(201, { id: 555, number: 9, html_url: "https://github.com/owner/repo/pull/9" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review"));

    const result = await openOrPushPr("github:1", "user");
    expect(result.ok).toBe(true);
    expect(commitMock).toHaveBeenCalledWith("/wt/repo/issue-1", "issue 1 (#1)");
    expect(pushMock).toHaveBeenCalledWith("/wt/repo/issue-1", "feature/issue-1", {
      username: "x-access-token",
      password: "tok",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/owner/repo/pulls");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      title: "issue 1",
      head: "feature/issue-1",
      base: "develop",
      draft: true,
    });
    expect(body.body).toContain("Closes #1");
    expect(h.prOpens[0]).toMatchObject({
      itemId: "github:1",
      pr: { id: "github:555", number: 9, url: "https://github.com/owner/repo/pull/9" },
      sha: "abc123",
      actor: "user",
      reason: "draft PR opened",
    });
  });

  it("writes a plain tracker reference when the issue lives on another provider (#299)", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse(201, { id: 555, number: 9, html_url: "https://github.com/owner/repo/pull/9" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set(
      "jira:1",
      makeItem(1, "human-review", {
        id: "jira:1",
        source: "jira",
        sourceRef: { project: "PROJ", key: "PROJ-7" },
        key: "PROJ-7",
        number: undefined,
        url: "https://acme.atlassian.net/browse/PROJ-7",
      }),
    );

    const result = await openOrPushPr("jira:1", "user");
    expect(result.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.body).toContain("Tracker issue: https://acme.atlassian.net/browse/PROJ-7");
    expect(body.body).not.toContain("Closes #");
  });

  it("pushes updates without creating a PR when the item already has one", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review", {
      pr: { id: "github:555", number: 9, url: "u" },
      shepherd: { lastPushedSha: "old000", pendingReviewComments: [{ body: "fix" }] },
    }));

    const result = await openOrPushPr("github:1", "user");
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.prOpens[0]).toMatchObject({ reason: "updates pushed to PR", sha: "abc123" });
  });

  it("refuses a repush when nothing changed since the last push", async () => {
    commitMock.mockResolvedValue({ committed: false, sha: "abc123" });
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review", {
      pr: { id: "github:555", number: 9, url: "u" },
      shepherd: { lastPushedSha: "abc123" },
    }));

    const result = await openOrPushPr("github:1", "user");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no new changes") });
    expect(pushMock).not.toHaveBeenCalled();
    expect(h.items.get("github:1")!.state).toBe("human-review");
  });

  it("adopts the existing open PR on a 422 create", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(422, { message: "already exists" });
      expect(String(url)).toContain("head=owner%3Afeature%2Fissue-1");
      return jsonResponse(200, [{ id: 777, number: 3, html_url: "https://github.com/owner/repo/pull/3" }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review"));

    const result = await openOrPushPr("github:1", "user");
    expect(result.ok).toBe(true);
    expect(h.prOpens[0].pr).toEqual({
      id: "github:777",
      number: 3,
      url: "https://github.com/owner/repo/pull/3",
    });
  });

  it("returns the error to the user without a transition", async () => {
    pushMock.mockRejectedValueOnce(new Error("push rejected (non-fast-forward): boom"));
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review"));

    const result = await openOrPushPr("github:1", "user");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("non-fast-forward") });
    expect(h.transitions).toEqual([]);
    expect(h.items.get("github:1")!.state).toBe("human-review");
  });

  it("parks the item in needs-input when the shepherd actor fails", async () => {
    pushMock.mockRejectedValueOnce(new Error("push failed"));
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review", {
      pr: { id: "github:555", number: 9, url: "u" },
    }));

    const result = await openOrPushPr("github:1", "shepherd");
    expect(result.ok).toBe(false);
    expect(h.transitions[0]).toMatchObject({
      to: "needs-input",
      actor: "shepherd",
      resumeTo: "human-review",
    });
  });
});

describe("shepherd scan — re-entry", () => {
  it("fetches review feedback and re-enters coding", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/reviews")) {
        return jsonResponse(200, [
          { user: { login: "rev" }, state: "CHANGES_REQUESTED", body: "please fix X" },
        ]);
      }
      if (u.includes("/comments")) {
        return jsonResponse(200, [
          { user: { login: "rev" }, path: "src/a.ts", line: 3, body: "rename this" },
        ]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "changes-requested", {
      pr: { id: "github:555", number: 9, url: "u" },
    }));

    pokeShepherd();
    await settle();

    expect(h.reentries).toHaveLength(1);
    expect(h.reentries[0].comments.map((c) => c.body)).toEqual(["please fix X", "rename this"]);
    expect(h.items.get("github:1")!.state).toBe("coding");
  });

  it("appends failing checks as feedback on a CI-triggered re-entry", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/check-runs")) {
        return jsonResponse(200, {
          check_runs: [
            {
              status: "completed",
              conclusion: "failure",
              name: "build",
              html_url: "cu",
              output: { title: "tsc failed" },
            },
            { status: "completed", conclusion: "success", name: "lint" },
          ],
        });
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "changes-requested", {
      pr: { id: "github:555", number: 9, url: "u" },
      shepherd: { lastPushedSha: "sha1", lastCiSha: "sha1" },
    }));

    pokeShepherd();
    await settle();

    expect(h.reentries).toHaveLength(1);
    expect(h.reentries[0].comments.map((c) => c.body)).toEqual([
      "CI check failed: build — tsc failed",
    ]);
    expect(h.reentries[0].comments[0].url).toBe("cu");
  });

  it("synthesizes a comment when changes were requested without text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, [])));
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "changes-requested", {
      pr: { id: "github:555", number: 9, url: "u" },
    }));

    pokeShepherd();
    await settle();

    expect(h.reentries[0].comments).toHaveLength(1);
    expect(h.reentries[0].comments[0].body).toContain("without written comments");
  });

  it("leaves the item in changes-requested when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "boom" })));
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "changes-requested", {
      pr: { id: "github:555", number: 9, url: "u" },
    }));

    pokeShepherd();
    await settle();

    expect(h.reentries).toEqual([]);
    expect(h.items.get("github:1")!.state).toBe("changes-requested");
  });
});

describe("shepherd scan — auto repush", () => {
  it("does nothing on the default human setting", async () => {
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review", {
      pr: { id: "github:555", number: 9, url: "u" },
    }));

    pokeShepherd();
    await settle();

    expect(h.prOpens).toEqual([]);
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("pushes unattended when shepherdRepush is auto", async () => {
    const h = makeHarness({
      getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, shepherdRepush: "auto" }),
    });
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review", {
      pr: { id: "github:555", number: 9, url: "u" },
      shepherd: { lastPushedSha: "old000" },
    }));

    pokeShepherd();
    await settle();

    expect(h.prOpens[0]).toMatchObject({ actor: "shepherd", reason: "updates pushed to PR" });
  });

  it("never auto-opens a first PR from human-review (no item.pr)", async () => {
    const h = makeHarness({
      getSettings: () => ({ ...DEFAULT_ORCHESTRATOR_SETTINGS, shepherdRepush: "auto" }),
    });
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "human-review"));

    pokeShepherd();
    await settle();

    expect(h.prOpens).toEqual([]);
    expect(commitMock).not.toHaveBeenCalled();
  });
});

describe("shepherd scan — merged capture", () => {
  it("captures the solution record, removes the worktree and stamps memoryRef", async () => {
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "merged", {
      pr: { id: "github:555", number: 9, url: "https://github.com/owner/repo/pull/9" },
    }));

    pokeShepherd();
    await settle();

    const ref = memoryFileName("github:1");
    expect(h.cleanups).toEqual([{ itemId: "github:1", memoryRef: ref }]);
    expect(captureMock).toHaveBeenCalledWith("/wt/repo/issue-1", "origin/develop");
    expect(removeMock).toHaveBeenCalledWith("/repos/repo", "/wt/repo/issue-1");
    expect(deleteBranchMock).toHaveBeenCalledWith("/repos/repo", "feature/issue-1");
    const record = JSON.parse(await readFile(join(memoryDir, ref), "utf-8"));
    expect(record).toMatchObject({
      // #256: capture writes the v2 shape directly.
      version: 2,
      itemId: "github:1",
      issueNumber: 1,
      pr: { number: 9 },
      outcome: "merged",
      diff: "+line",
    });
  });

  it("still captures when the diff fails, without the diff", async () => {
    captureMock.mockRejectedValueOnce(new Error("worktree gone"));
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "merged", {
      pr: { id: "github:555", number: 9, url: "u" },
    }));

    pokeShepherd();
    await settle();

    expect(h.cleanups).toHaveLength(1);
    const record = JSON.parse(await readFile(join(memoryDir, h.cleanups[0].memoryRef), "utf-8"));
    expect(record.diff).toBeUndefined();
  });

  it("is idempotent — a stamped memoryRef is never recaptured", async () => {
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", makeItem(1, "merged", {
      pr: { id: "github:555", number: 9, url: "u" },
      shepherd: { memoryRef: "done.json" },
    }));

    pokeShepherd();
    await settle();

    expect(h.cleanups).toEqual([]);
    expect(captureMock).not.toHaveBeenCalled();
  });
});

// Lesson distillation at capture (#256). The contract is that the record lands
// first and the lesson is a bonus: nothing here may cost a memory.
describe("shepherd scan — lesson distillation", () => {
  const mergedItem = (extra: Partial<TrackedItem> = {}) =>
    makeItem(1, "merged", {
      pr: { id: "github:555", number: 9, url: "https://example.test/pr/9" },
      ...extra,
    });

  const readCaptured = async (ref: string): Promise<SolutionRecord> =>
    JSON.parse(await readFile(join(memoryDir, ref), "utf-8")) as SolutionRecord;

  it("rewrites the record with the lesson and indexes it for retrieval", async () => {
    const distillLesson = vi.fn(async () => "Problem: pty resize\nInsight: debounce the handler");
    const h = makeHarness({ distillLesson });
    initShepherd(h.deps);
    h.items.set("github:1", mergedItem());

    pokeShepherd();
    await settle();

    const record = await readCaptured(h.cleanups[0].memoryRef);
    expect(record.lesson).toBe("Problem: pty resize\nInsight: debounce the handler");
    expect(Date.parse(record.distilledAt!)).not.toBeNaN();
    expect(record.version).toBe(2);

    // indexOneRecord ran: reconcile only heals absences, so retrieval by the
    // lesson's own wording is the proof the new text was embedded.
    const hits = await searchMemory(memoryDir, "debounce the pty resize handler", {
      repo: { owner: "owner", name: "repo" },
    });
    expect(hits.map((hit) => hit.id)).toEqual(["github:1"]);
  });

  it("feeds the distiller the record's plan, diff and every review round", async () => {
    const distillLesson = vi.fn(async (_input: DistillInput) => "Problem: p\nInsight: i");
    const h = makeHarness({
      distillLesson,
      getPlan: async () => ({
        version: 2,
        itemId: "github:1",
        repo: { owner: "owner", name: "repo" },
        generatedAt: "2026-07-01T00:00:00.000Z",
        model: "test",
        plan: {
          summary: "swap the expiry comparison",
          files: [],
          steps: [{ title: "invert it", detail: "", files: [], symbols: [] }],
          acceptance: [],
          risks: [],
          openQuestions: [],
          estimatedSize: "s",
        },
      }),
    });
    initShepherd(h.deps);
    h.items.set(
      "github:1",
      mergedItem({
        review: {
          rounds: 2,
          outcome: "approve",
          at: "2026-07-13T02:00:00.000Z",
          history: [
            { round: 1, outcome: "reject", at: "2026-07-13T01:00:00.000Z" },
          ],
        },
      }),
    );

    pokeShepherd();
    await settle();

    expect(distillLesson).toHaveBeenCalledTimes(1);
    expect(distillLesson.mock.calls[0][0]).toMatchObject({
      title: "issue 1",
      planSummary: "swap the expiry comparison",
      planSteps: ["invert it"],
      diff: "+line",
      // History plus the live record: the current round is only snapshotted onto
      // history when it is overwritten, so it would otherwise be lost.
      reviewRounds: [
        { round: 1, outcome: "reject" },
        { round: 2, outcome: "approve" },
      ],
    });
  });

  it("captures the record before distilling, so a slow lesson never delays it", async () => {
    let onDiskWhenDistilling: SolutionRecord | null = null;
    const distillLesson = vi.fn(async () => {
      onDiskWhenDistilling = await readCaptured(memoryFileName("github:1"));
      return "Problem: p\nInsight: i";
    });
    const h = makeHarness({ distillLesson });
    initShepherd(h.deps);
    h.items.set("github:1", mergedItem());

    pokeShepherd();
    await settle();

    expect(onDiskWhenDistilling).toMatchObject({ itemId: "github:1", outcome: "merged" });
  });

  it("keeps the capture when the distiller throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const distillLesson = vi.fn(async () => {
      throw new Error("runtime exploded");
    });
    const h = makeHarness({ distillLesson });
    initShepherd(h.deps);
    h.items.set("github:1", mergedItem());

    pokeShepherd();
    await settle();

    expect(h.cleanups).toHaveLength(1);
    const record = await readCaptured(h.cleanups[0].memoryRef);
    expect(record.lesson).toBeUndefined();
    expect(record.distilledAt).toBeUndefined();
    // The worktree teardown still ran — distillation sits before it, not instead.
    expect(removeMock).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
  });

  it("stamps nothing when the distiller declines to produce a lesson", async () => {
    const h = makeHarness({ distillLesson: vi.fn(async () => null) });
    initShepherd(h.deps);
    h.items.set("github:1", mergedItem());

    pokeShepherd();
    await settle();

    const record = await readCaptured(h.cleanups[0].memoryRef);
    expect(record.lesson).toBeUndefined();
    expect(record.distilledAt).toBeUndefined();
  });

  it("captures plainly when no distiller is wired in", async () => {
    const h = makeHarness();
    initShepherd(h.deps);
    h.items.set("github:1", mergedItem());

    pokeShepherd();
    await settle();

    expect(h.cleanups).toHaveLength(1);
    expect((await readCaptured(h.cleanups[0].memoryRef)).lesson).toBeUndefined();
  });
});
