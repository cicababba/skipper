import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoInstructions, seedRepoInstructions } from "./repo-instructions";

// The seed ladder (#241, extended with GEMINI.md in #243): the repo's own agent
// instructions are copied when there are any, and generation is only the last
// resort. Order is CLAUDE.md > AGENTS.md > .github/copilot-instructions.md >
// GEMINI.md, first non-blank hit wins.
const REPO_KEY = "cicababba/skipper";

let dir: string;
let repoPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skipper-instructions-state-"));
  repoPath = await mkdtemp(join(tmpdir(), "skipper-instructions-repo-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(repoPath, { recursive: true, force: true });
});

const seedFile = async (file: string, content: string) => {
  const path = join(repoPath, file);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
};

const COPILOT_FILE = join(".github", "copilot-instructions.md");

/** Seeds and, when generation is the outcome, waits for it to settle. */
async function seed(generate: () => Promise<string>) {
  let settled: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  await seedRepoInstructions({
    dir,
    repoKey: REPO_KEY,
    repoPath,
    generate,
    onSettled: settled,
  });
  const doc = await loadRepoInstructions(dir, REPO_KEY);
  return { doc, generated: done };
}

describe("seedRepoInstructions ladder", () => {
  it("picks up GEMINI.md as source gemini-md when the first three miss", async () => {
    await seedFile("GEMINI.md", "# Gemini conventions\n\nuse pnpm");
    const generate = vi.fn(async () => "never");
    const { doc } = await seed(generate);

    expect(doc).toMatchObject({
      version: 1,
      content: "# Gemini conventions\n\nuse pnpm",
      source: "gemini-md",
      status: "ready",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("loses to each of the three rungs above it", async () => {
    const cases: { file: string; source: string }[] = [
      { file: "CLAUDE.md", source: "claude-md" },
      { file: "AGENTS.md", source: "agents-md" },
      { file: COPILOT_FILE, source: "copilot-instructions" },
    ];
    for (const { file, source } of cases) {
      await rm(dir, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "skipper-instructions-state-"));
      repoPath = await mkdtemp(join(tmpdir(), "skipper-instructions-repo-"));

      await seedFile(file, `# from ${file}`);
      await seedFile("GEMINI.md", "# from GEMINI.md");
      const { doc } = await seed(async () => "never");
      expect(doc?.source).toBe(source);
      expect(doc?.content).toBe(`# from ${file}`);
    }
  });

  // A whitespace-only file is a miss (an empty doc is useless), so the ladder
  // falls through to the next candidate rather than seeding nothing.
  it("falls through a blank higher rung to GEMINI.md", async () => {
    await seedFile("CLAUDE.md", "   \n\n");
    await seedFile("AGENTS.md", "");
    await seedFile("GEMINI.md", "# real conventions");
    const { doc } = await seed(async () => "never");
    expect(doc?.source).toBe("gemini-md");
    expect(doc?.content).toBe("# real conventions");
  });

  it("generates when GEMINI.md is blank and nothing else exists", async () => {
    await seedFile("GEMINI.md", "  ");
    const generate = vi.fn(async () => "# generated conventions");
    const { doc, generated } = await seed(generate);

    expect(doc).toMatchObject({ source: "generated", status: "generating" });
    await generated;
    expect(generate).toHaveBeenCalled();
    expect(await loadRepoInstructions(dir, REPO_KEY)).toMatchObject({
      content: "# generated conventions",
      source: "generated",
      status: "ready",
    });
  });
});
