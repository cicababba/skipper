import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ORCHESTRATOR_SETTINGS, type OrchestratorManifest } from "@skipper/core";
import type {
  Issue,
  LifecycleState,
  OrchestratorState,
  SetRepoFollowedResult,
  TrackedItem,
} from "@skipper/shared";
import { registerRepoFollowHandlers, type RepoFollowIpcDeps } from "./repo-follow-ipc";

type Handler = (event: unknown, ...args: unknown[]) => Promise<SetRepoFollowedResult>;

const CHANNEL = "skipper:orchestrator:setRepoFollowed";
const REPO = { owner: "octo", name: "demo" };

function tracked(id: string, state: LifecycleState): TrackedItem {
  return {
    id,
    source: "github",
    sourceRef: { project: "octo/demo", key: id },
    codeHost: "github",
    accountId: "github:1",
    repo: REPO,
    key: id,
    title: `item ${id}`,
    url: `https://github.com/octo/demo/issues/${id}`,
    state,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    transitions: [],
  };
}

function cachedIssue(id: string): Issue {
  return {
    kind: "issue",
    id,
    source: "github",
    sourceRef: { project: "octo/demo", key: id },
    codeHost: "github",
    accountId: "github:1",
    repo: REPO,
    key: id,
    title: `issue ${id}`,
    labels: [],
    assignees: [],
    url: `https://github.com/octo/demo/issues/${id}`,
    state: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function setup(patch: Partial<OrchestratorManifest> = {}, cache: Issue[] = []) {
  const m: OrchestratorManifest = {
    version: 3,
    settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS },
    items: {},
    parked: {},
    repoSettings: {},
    projectMappings: {},
    ...patch,
  };
  const handlers = new Map<string, Handler>();
  const saveManifest = vi.fn(async () => {});
  const reconcileFromCache = vi.fn(async () => {});
  const broadcast = vi.fn();
  const deps = {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    ensureManifest: async () => m,
    saveManifest,
    cachedItems: () => cache,
    reconcileFromCache,
    broadcast,
    snapshot: () => ({ repoSettings: m.repoSettings }) as unknown as OrchestratorState,
  } as unknown as RepoFollowIpcDeps;
  registerRepoFollowHandlers(deps);
  const handler = handlers.get(CHANNEL);
  if (!handler) throw new Error("handler not registered");
  return { m, handler, handlers, saveManifest, reconcileFromCache, broadcast };
}

describe("registerRepoFollowHandlers", () => {
  it("registers the setRepoFollowed channel", () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([CHANNEL]);
  });

  it("rejects a blank owner or name without touching the manifest", async () => {
    const { handler, saveManifest } = setup();
    expect(await handler(null, "  ", "demo", true)).toEqual({
      ok: false,
      error: "repo owner and name are required",
      blocking: [],
    });
    expect(await handler(null, "octo", "", true)).toEqual({
      ok: false,
      error: "repo owner and name are required",
      blocking: [],
    });
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it("follows a repo and reconciles so cached issues admit retroactively", async () => {
    const { m, handler, saveManifest, reconcileFromCache, broadcast } = setup();
    const res = await handler(null, "octo", "demo", true);
    expect(res.ok).toBe(true);
    expect(m.repoSettings["octo/demo"]).toEqual({ followed: true });
    expect(saveManifest).toHaveBeenCalledTimes(1);
    expect(reconcileFromCache).toHaveBeenCalledTimes(1);
    // reconcileFromCache broadcasts on its own — no double push.
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("unfollows a repo whose items are all settled", async () => {
    const { m, handler, saveManifest, reconcileFromCache, broadcast } = setup({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", "merged"), b: tracked("b", "closed") },
    });
    const res = await handler(null, "octo", "demo", false);
    expect(res.ok).toBe(true);
    expect(m.repoSettings["octo/demo"]).toEqual({ followed: false });
    expect(saveManifest).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(reconcileFromCache).not.toHaveBeenCalled();
  });

  it("refuses to unfollow a repo with an active item and reports the blockers", async () => {
    const { m, handler, saveManifest } = setup({
      repoSettings: { "octo/demo": { followed: true } },
      items: { a: tracked("a", "plan-gate"), b: tracked("b", "merged") },
    });
    const res = await handler(null, "octo", "demo", false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocking).toEqual([{ id: "a", key: "a", state: "plan-gate" }]);
    expect(res.error).toContain("1 active item");
    expect(m.repoSettings["octo/demo"]).toEqual({ followed: true });
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it("purges the repo's parked issues when it is unfollowed", async () => {
    const { m, handler } = setup(
      {
        repoSettings: { "octo/demo": { followed: true } },
        parked: {
          "github:1": { firstSeenAt: "2026-07-01T00:00:00.000Z" },
          "github:9": { firstSeenAt: "2026-07-01T00:00:00.000Z" },
        },
      },
      [cachedIssue("github:1")],
    );
    expect((await handler(null, "octo", "demo", false)).ok).toBe(true);
    expect(Object.keys(m.parked)).toEqual(["github:9"]);
  });

  it("trims the repo path before writing the key", async () => {
    const { m, handler } = setup();
    expect((await handler(null, " Octo ", " Demo ", true)).ok).toBe(true);
    expect(Object.keys(m.repoSettings)).toEqual(["octo/demo"]);
  });
});
