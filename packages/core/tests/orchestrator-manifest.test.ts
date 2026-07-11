import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateOrchestratorManifest,
  saveOrchestratorManifest,
  admitItem,
  type OrchestratorManifest,
} from "../src/orchestrator";
import type { Issue } from "@nestbrain/shared";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-orch-"));
  filePath = join(dir, "orchestrator-manifest.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function issue(n: number): Issue {
  return {
    id: `github:${n}`,
    kind: "issue",
    platform: "github",
    accountId: "acct-1",
    repo: { owner: "o", name: "r" },
    number: n,
    title: `Issue ${n}`,
    labels: [],
    assignees: [],
    url: `https://github.com/o/r/issues/${n}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
  };
}

describe("orchestrator manifest", () => {
  it("returns a fresh manifest when the file is missing", async () => {
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest).toEqual({
      version: 1,
      settings: { intakePaused: false },
      items: {},
      parked: {},
    });
  });

  it("round-trips items, settings and parked entries", async () => {
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    const item = admitItem(issue(7));
    manifest.items[item.id] = item;
    manifest.settings.intakePaused = true;
    manifest.parked["github:8"] = { firstSeenAt: "2026-07-11T10:00:00.000Z" };
    await saveOrchestratorManifest(filePath, manifest);

    const loaded = await loadOrCreateOrchestratorManifest(filePath);
    expect(loaded).toEqual(manifest);
  });

  it("returns a fresh manifest on corrupt JSON", async () => {
    await writeFile(filePath, "{ not json", "utf-8");
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.version).toBe(1);
    expect(manifest.items).toEqual({});
  });

  it("returns a fresh manifest on version mismatch", async () => {
    await writeFile(filePath, JSON.stringify({ version: 2, items: { x: {} } }), "utf-8");
    const manifest = await loadOrCreateOrchestratorManifest(filePath);
    expect(manifest.version).toBe(1);
    expect(manifest.items).toEqual({});
  });

  it("serializes concurrent saves — last write wins and the file stays valid", async () => {
    const base: OrchestratorManifest = {
      version: 1,
      settings: { intakePaused: false },
      items: {},
      parked: {},
    };
    const saves = Array.from({ length: 10 }, (_, i) =>
      saveOrchestratorManifest(filePath, {
        ...base,
        parked: { [`github:${i}`]: { firstSeenAt: `2026-07-11T10:00:0${i % 10}.000Z` } },
      }),
    );
    await Promise.all(saves);

    const raw = JSON.parse(await readFile(filePath, "utf-8")) as OrchestratorManifest;
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.parked)).toEqual(["github:9"]);
  });
});
