import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORCHESTRATOR_SETTINGS, type OrchestratorManifest } from "@skipper/core";
import type { RepoInstructionsDoc, RepoRef } from "@skipper/shared";
import {
  isInstructionsGenerating,
  loadRepoInstructions,
  saveRepoInstructions,
} from "./repo-instructions";
import { isGraphifyRunning, loadGraphifyDoc } from "./graphify-store";
import type { RepoLinksFile } from "./repo-links";
import { registerRepoConfigHandlers, type RepoConfigIpcDeps } from "./repo-config-ipc";

vi.mock("./repo-instructions", () => ({
  isInstructionsGenerating: vi.fn(() => false),
  loadRepoInstructions: vi.fn(async () => null),
  saveRepoInstructions: vi.fn(async () => {}),
}));
vi.mock("./graphify-store", () => ({
  isGraphifyRunning: vi.fn(() => false),
  loadGraphifyDoc: vi.fn(async () => null),
}));

const isInstructionsGeneratingMock = vi.mocked(isInstructionsGenerating);
const loadRepoInstructionsMock = vi.mocked(loadRepoInstructions);
const saveRepoInstructionsMock = vi.mocked(saveRepoInstructions);
const isGraphifyRunningMock = vi.mocked(isGraphifyRunning);
const loadGraphifyDocMock = vi.mocked(loadGraphifyDoc);

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function manifest(overrides: Partial<OrchestratorManifest> = {}): OrchestratorManifest {
  return {
    version: 3,
    settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS },
    items: {},
    parked: {},
    repoSettings: {},
    projectMappings: {},
    ...overrides,
  };
}

interface SetupOptions {
  manifest?: OrchestratorManifest;
  links?: RepoLinksFile;
}

function setup(opts: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const broadcast = vi.fn();
  const pokePlanner = vi.fn();
  const seedInstructions = vi.fn(
    async (_repo: RepoRef, _localPath: string, _force?: boolean) => {},
  );
  const kickGraphify = vi.fn();
  const deps: RepoConfigIpcDeps = {
    ipcMain: ipcMain as unknown as RepoConfigIpcDeps["ipcMain"],
    repoInstructionsDir: "/data/repo-instructions",
    graphsDir: "/data/graphs",
    ensureManifest: async () => opts.manifest ?? manifest(),
    ensureRepoLinks: async () => opts.links ?? { version: 1, repos: {} },
    broadcast,
    pokePlanner,
    seedInstructions,
    kickGraphify,
  };
  registerRepoConfigHandlers(deps);
  return { handlers, broadcast, pokePlanner, seedInstructions, kickGraphify };
}

function handlerOf(handlers: Map<string, Handler>, channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler ${channel} not registered`);
  return handler;
}

const linked: RepoLinksFile = {
  version: 1,
  repos: { "acme/widgets": { localPath: "/repo", linkedAt: "t" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  isInstructionsGeneratingMock.mockReturnValue(false);
  loadRepoInstructionsMock.mockResolvedValue(null);
  saveRepoInstructionsMock.mockResolvedValue(undefined);
  isGraphifyRunningMock.mockReturnValue(false);
  loadGraphifyDocMock.mockResolvedValue(null);
});

describe("registerRepoConfigHandlers", () => {
  it("registers the five repo-config channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      "skipper:orchestrator:getRepoGraphify",
      "skipper:orchestrator:getRepoInstructions",
      "skipper:orchestrator:regenerateRepoInstructions",
      "skipper:orchestrator:reindexRepoGraphify",
      "skipper:orchestrator:setRepoInstructions",
    ]);
  });
});

describe("getRepoInstructions", () => {
  it("reads the doc for the repo key", async () => {
    const doc = { version: 1, content: "conventions", updatedAt: "t", source: "claude-md", status: "ready" } as RepoInstructionsDoc;
    loadRepoInstructionsMock.mockResolvedValue(doc);
    const h = setup();
    const res = await handlerOf(h.handlers, "skipper:orchestrator:getRepoInstructions")(
      null,
      "Acme",
      "Widgets",
    );
    expect(res).toEqual({ ok: true, doc });
    expect(loadRepoInstructionsMock).toHaveBeenCalledWith("/data/repo-instructions", "acme/widgets");
  });

  it("returns the store error", async () => {
    loadRepoInstructionsMock.mockRejectedValue(new Error("unreadable"));
    const h = setup();
    const res = await handlerOf(h.handlers, "skipper:orchestrator:getRepoInstructions")(
      null,
      "acme",
      "widgets",
    );
    expect(res).toEqual({ ok: false, error: "unreadable" });
  });
});

describe("setRepoInstructions", () => {
  const CHANNEL = "skipper:orchestrator:setRepoInstructions";

  it("clamps the content, marks it edited and ready, then broadcasts and pokes", async () => {
    const h = setup();
    const res = (await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", "x".repeat(150_000))) as {
      ok: true;
      doc: RepoInstructionsDoc;
    };
    expect(res.ok).toBe(true);
    expect(res.doc.content).toHaveLength(100_000);
    expect(res.doc).toMatchObject({ version: 1, source: "edited", status: "ready" });
    expect(saveRepoInstructionsMock).toHaveBeenCalledWith(
      "/data/repo-instructions",
      "acme/widgets",
      res.doc,
    );
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.pokePlanner).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-string body without touching the store", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets", 42);
    expect(res).toEqual({ ok: false, error: "content must be a string" });
    expect(saveRepoInstructionsMock).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });
});

describe("regenerateRepoInstructions", () => {
  const CHANNEL = "skipper:orchestrator:regenerateRepoInstructions";

  it("refuses when the repo is not linked", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets");
    expect(res).toEqual({ ok: false, error: "repo not linked" });
    expect(h.seedInstructions).not.toHaveBeenCalled();
  });

  it("refuses when a generation is already running", async () => {
    isInstructionsGeneratingMock.mockReturnValue(true);
    const h = setup({ links: linked });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets");
    expect(res).toEqual({ ok: false, error: "generation already running" });
    expect(h.seedInstructions).not.toHaveBeenCalled();
  });

  it("kicks a forced reseed in the background and broadcasts", async () => {
    const h = setup({ links: linked });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets");
    expect(res).toEqual({ ok: true });
    expect(h.seedInstructions).toHaveBeenCalledWith(
      { owner: "acme", name: "widgets" },
      "/repo",
      true,
    );
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });
});

describe("getRepoGraphify", () => {
  it("reads the doc for the repo key", async () => {
    const h = setup();
    const res = await handlerOf(h.handlers, "skipper:orchestrator:getRepoGraphify")(
      null,
      "acme",
      "widgets",
    );
    expect(res).toEqual({ ok: true, doc: null });
    expect(loadGraphifyDocMock).toHaveBeenCalledWith("/data/graphs", "acme/widgets");
  });
});

describe("reindexRepoGraphify", () => {
  const CHANNEL = "skipper:orchestrator:reindexRepoGraphify";
  const graphifyOn = manifest({ repoSettings: { "acme/widgets": { graphify: true } } });

  it("refuses when the repo is not linked", async () => {
    const h = setup({ manifest: graphifyOn });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets");
    expect(res).toEqual({ ok: false, error: "repo not linked" });
    expect(h.kickGraphify).not.toHaveBeenCalled();
  });

  it("refuses when Graphify is off for the repo", async () => {
    const h = setup({ links: linked });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets");
    expect(res).toEqual({ ok: false, error: "Graphify is off for this repo" });
    expect(h.kickGraphify).not.toHaveBeenCalled();
  });

  it("refuses when an index run is already going", async () => {
    isGraphifyRunningMock.mockReturnValue(true);
    const h = setup({ links: linked, manifest: graphifyOn });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets");
    expect(res).toEqual({ ok: false, error: "indexing already running" });
    expect(h.kickGraphify).not.toHaveBeenCalled();
  });

  it("kicks the index when linked, enabled and idle", async () => {
    const h = setup({ links: linked, manifest: graphifyOn });
    const res = await handlerOf(h.handlers, CHANNEL)(null, "acme", "widgets");
    expect(res).toEqual({ ok: true });
    expect(h.kickGraphify).toHaveBeenCalledWith({ owner: "acme", name: "widgets" });
  });
});
