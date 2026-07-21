import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssuePlan } from "@skipper/shared";
import { scoreGroundedness } from "../src/confidence";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "nb-ground-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "poller.ts"), "export function pollNow() {}\n", "utf-8");
  await writeFile(join(repo, "src", "other.ts"), "export const backoff = 1;\n", "utf-8");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function plan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "s",
    files: [{ path: "src/poller.ts", reason: "r" }],
    steps: [{ title: "t", detail: "d", files: ["src/poller.ts"], symbols: ["pollNow"] }],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
    ...overrides,
  };
}

describe("scoreGroundedness", () => {
  it("scores 1.0 when every cited file and symbol exists", async () => {
    const s = await scoreGroundedness(plan(), repo);
    expect(s.score).toBeCloseTo(1);
    expect(s.filesFound).toBe(1);
    expect(s.symbolsFound).toBe(1);
    expect(s.missingFiles).toEqual([]);
    expect(s.missingSymbols).toEqual([]);
  });

  it("lists missing files and lowers the score", async () => {
    const s = await scoreGroundedness(
      plan({ files: [{ path: "src/poller.ts", reason: "r" }, { path: "src/ghost.ts", reason: "r" }] }),
      repo,
    );
    expect(s.filesChecked).toBe(2);
    expect(s.filesFound).toBe(1);
    expect(s.missingFiles).toEqual(["src/ghost.ts"]);
    expect(s.score).toBeLessThan(1);
  });

  it("exempts files declared new", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [
          { path: "src/poller.ts", reason: "r" },
          { path: "src/created.ts", reason: "r", status: "new" },
        ],
      }),
      repo,
    );
    expect(s.filesChecked).toBe(1);
    expect(s.missingFiles).toEqual([]);
    expect(s.newFiles).toEqual(["src/created.ts"]);
    expect(s.score).toBeCloseTo(1);
  });

  it("exempts symbols in steps whose files are all new", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [{ path: "src/created.ts", reason: "r", status: "new" }],
        steps: [{ title: "t", detail: "d", files: ["src/created.ts"], symbols: ["brandNewFn"] }],
      }),
      repo,
    );
    expect(s.symbolsChecked).toBe(0);
    expect(s.score).toBeCloseTo(1);
  });

  it("finds symbols outside the cited files via the repo walk", async () => {
    const s = await scoreGroundedness(
      plan({ steps: [{ title: "t", detail: "d", files: ["src/poller.ts"], symbols: ["backoff"] }] }),
      repo,
    );
    expect(s.symbolsFound).toBe(1);
    expect(s.missingSymbols).toEqual([]);
  });

  it("reports missing symbols", async () => {
    const s = await scoreGroundedness(
      plan({ steps: [{ title: "t", detail: "d", files: ["src/poller.ts"], symbols: ["ghostFn"] }] }),
      repo,
    );
    expect(s.symbolsFound).toBe(0);
    expect(s.missingSymbols).toEqual(["ghostFn"]);
    expect(s.score).toBeCloseTo(0.7);
  });

  it("treats absolute and escaping paths as missing", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [
          { path: "/etc/passwd", reason: "r" },
          { path: "../outside.ts", reason: "r" },
        ],
        steps: [{ title: "t", detail: "d", files: [], symbols: [] }],
      }),
      repo,
    );
    expect(s.filesFound).toBe(0);
    expect(s.missingFiles).toEqual(["../outside.ts", "/etc/passwd"]);
  });

  it("throws when repoPath does not exist instead of fabricating an all-missing score", async () => {
    await expect(scoreGroundedness(plan(), join(repo, "does-not-exist"))).rejects.toThrow();
  });

  it("throws when repoPath points at a file", async () => {
    await expect(scoreGroundedness(plan(), join(repo, "src", "poller.ts"))).rejects.toThrow();
  });

  it("scores empty denominators as 1", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [{ path: "src/created.ts", reason: "r", status: "new" }],
        steps: [{ title: "t", detail: "d", files: [], symbols: [] }],
      }),
      repo,
    );
    expect(s.filesChecked).toBe(0);
    expect(s.symbolsChecked).toBe(0);
    expect(s.score).toBeCloseTo(1);
  });
});
