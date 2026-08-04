import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssuePlan } from "@skipper/shared";
import { GROUNDEDNESS_VETO, scoreGroundedness } from "../src/confidence";

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
    expect(s.coverage).toBeCloseTo(0.7);
    expect(s.score).toBeCloseTo(0.4);
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

  it("exempts createdSymbols in a mixed new+existing step and reports them", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [
          { path: "src/poller.ts", reason: "r" },
          { path: "src/created.ts", reason: "r", status: "new" },
        ],
        steps: [
          {
            title: "t",
            detail: "d",
            files: ["src/poller.ts", "src/created.ts"],
            symbols: ["pollNow", "brandNewFn"],
            createdSymbols: ["brandNewFn"],
          },
        ],
      }),
      repo,
    );
    expect(s.symbolsChecked).toBe(1);
    expect(s.symbolsFound).toBe(1);
    expect(s.missingSymbols).toEqual([]);
    expect(s.createdSymbols).toEqual(["brandNewFn"]);
    expect(s.score).toBeCloseTo(1);
  });

  it("exempts a created symbol cited in a later existing-files-only step (plan-wide)", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [
          { path: "src/poller.ts", reason: "r" },
          { path: "src/created.ts", reason: "r", status: "new" },
        ],
        steps: [
          {
            title: "create",
            detail: "d",
            files: ["src/created.ts"],
            symbols: [],
            createdSymbols: ["brandNewFn"],
          },
          {
            title: "wire",
            detail: "d",
            files: ["src/poller.ts"],
            symbols: ["brandNewFn"],
          },
        ],
      }),
      repo,
    );
    expect(s.symbolsChecked).toBe(0);
    expect(s.createdSymbols).toEqual(["brandNewFn"]);
    expect(s.score).toBeCloseTo(1);
  });

  it("still counts a genuinely missing symbol not in createdSymbols", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [
          { path: "src/poller.ts", reason: "r" },
          { path: "src/created.ts", reason: "r", status: "new" },
        ],
        steps: [
          {
            title: "t",
            detail: "d",
            files: ["src/poller.ts", "src/created.ts"],
            symbols: ["brandNewFn", "ghostFn"],
            createdSymbols: ["brandNewFn"],
          },
        ],
      }),
      repo,
    );
    expect(s.symbolsChecked).toBe(1);
    expect(s.missingSymbols).toEqual(["ghostFn"]);
    expect(s.score).toBeCloseTo(0.4);
  });

  it("counts a mixed step's symbols as before when createdSymbols is absent", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [
          { path: "src/poller.ts", reason: "r" },
          { path: "src/created.ts", reason: "r", status: "new" },
        ],
        steps: [
          {
            title: "t",
            detail: "d",
            files: ["src/poller.ts", "src/created.ts"],
            symbols: ["brandNewFn"],
          },
        ],
      }),
      repo,
    );
    expect(s.symbolsChecked).toBe(1);
    expect(s.missingSymbols).toEqual(["brandNewFn"]);
    expect(s.createdSymbols).toEqual([]);
    expect(s.score).toBeCloseTo(0.4);
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

// #309: the raw coverage stays reported, but the score is rescaled onto the band
// above the veto — below it nothing grades, because the veto already decided.
describe("scoreGroundedness coverage transfer (#309)", () => {
  it("vetoes at coverage 0.5", () => {
    expect(GROUNDEDNESS_VETO).toBe(0.5);
  });

  it("keeps a perfect plan at 1.0", async () => {
    const s = await scoreGroundedness(plan(), repo);
    expect(s.coverage).toBeCloseTo(1);
    expect(s.score).toBeCloseTo(1);
  });

  it("maps coverage 0.9 to 0.8", async () => {
    const s = await scoreGroundedness(
      plan({
        steps: [
          {
            title: "t",
            detail: "d",
            files: ["src/poller.ts"],
            symbols: ["pollNow", "backoff", "ghostFn"],
          },
        ],
      }),
      repo,
    );
    expect(s.coverage).toBeCloseTo(0.9);
    expect(s.score).toBeCloseTo(0.8);
  });

  it("maps coverage 0.5 — the veto boundary — to 0", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [
          { path: "src/poller.ts", reason: "r" },
          { path: "src/ghost.ts", reason: "r" },
        ],
        steps: [
          { title: "t", detail: "d", files: ["src/poller.ts"], symbols: ["pollNow", "ghostFn"] },
        ],
      }),
      repo,
    );
    expect(s.coverage).toBeCloseTo(0.5);
    expect(s.score).toBe(0);
  });

  it("floors coverage 0.3 at 0 instead of going negative", async () => {
    const s = await scoreGroundedness(
      plan({
        files: [{ path: "src/ghost.ts", reason: "r" }],
        steps: [{ title: "t", detail: "d", files: ["src/ghost.ts"], symbols: ["pollNow"] }],
      }),
      repo,
    );
    expect(s.coverage).toBeCloseTo(0.3);
    expect(s.score).toBe(0);
  });
});

// #178 B7: a short symbol must match as a whole identifier, not as a substring
// inside an unrelated word — an unbounded includes() inflated groundedness.
describe("scoreGroundedness symbol matching (#178 B7)", () => {
  function symPlan(symbols: string[]): IssuePlan {
    return plan({ steps: [{ title: "t", detail: "d", files: ["src/poller.ts"], symbols }] });
  }

  it("does not count a short symbol found only inside a larger word", async () => {
    await writeFile(join(repo, "src", "words.ts"), "const isValid = true;\nfunction runner() {}\n", "utf-8");
    const s = await scoreGroundedness(symPlan(["id", "run"]), repo);
    expect(s.missingSymbols).toEqual(["id", "run"]);
    expect(s.symbolsFound).toBe(0);
  });

  it("counts a symbol present as a whole identifier", async () => {
    await writeFile(join(repo, "src", "words.ts"), "export const id = 1;\n", "utf-8");
    const s = await scoreGroundedness(symPlan(["id"]), repo);
    expect(s.symbolsFound).toBe(1);
    expect(s.missingSymbols).toEqual([]);
  });

  it("matches a punctuation-edged symbol by substring on that edge", async () => {
    await writeFile(join(repo, "src", "words.ts"), "obj.doThing();\n", "utf-8");
    const s = await scoreGroundedness(symPlan([".doThing"]), repo);
    expect(s.symbolsFound).toBe(1);
  });

  it("skips a binary file, so a symbol only present there reads as missing", async () => {
    await writeFile(join(repo, "src", "blob.dat"), Buffer.from("uniqueSym\0more", "utf-8"));
    const s = await scoreGroundedness(symPlan(["uniqueSym"]), repo);
    expect(s.missingSymbols).toEqual(["uniqueSym"]);
  });

  it("skips a file over the byte cap, so a symbol only there reads as missing", async () => {
    await writeFile(join(repo, "src", "big.ts"), "x".repeat(1024 * 1024 + 16) + " hugeSym\n", "utf-8");
    const s = await scoreGroundedness(symPlan(["hugeSym"]), repo);
    expect(s.missingSymbols).toEqual(["hugeSym"]);
  });
});
