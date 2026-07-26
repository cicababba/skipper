// Per-repo agent-instructions docs (#227), one JSON file per repo under
// <userData>/repo-instructions/. Skipper-owned conventions the planner/coder are
// prompted with; seeded from the repo's existing agent instructions at link
// (#241 ladder), else generated. Pure
// Node module (no electron import) so it stays unit-testable; callers inject the
// directory and the generation function. Mirrors plan-store's per-entity JSON
// pattern (sanitized filename + tmp+rename + save queue).

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RepoInstructionsDoc, RepoInstructionsSource } from "@skipper/shared";

/** repoKey contains "/" which is illegal on Windows filenames. */
export function instructionsFileName(repoKey: string): string {
  return `${repoKey.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

function docPath(dir: string, repoKey: string): string {
  return join(dir, instructionsFileName(repoKey));
}

// Serialized saves so a concurrent seed + user edit never race the write+rename.
const saveQueue = new Map<string, Promise<void>>();

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf-8");
  await rename(tmp, path);
}

async function writeDocFile(path: string, doc: RepoInstructionsDoc): Promise<void> {
  const bytes = JSON.stringify(doc, null, 2);
  const prev = saveQueue.get(path) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* swallow previous error so this save still runs */
    })
    .then(() => writeAtomic(path, bytes));
  saveQueue.set(path, next);
  try {
    await next;
  } finally {
    if (saveQueue.get(path) === next) saveQueue.delete(path);
  }
}

async function readDocFile(path: string): Promise<RepoInstructionsDoc | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as RepoInstructionsDoc;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function loadRepoInstructions(
  dir: string,
  repoKey: string,
): Promise<RepoInstructionsDoc | null> {
  return readDocFile(docPath(dir, repoKey));
}

export function saveRepoInstructions(
  dir: string,
  repoKey: string,
  doc: RepoInstructionsDoc,
): Promise<void> {
  return writeDocFile(docPath(dir, repoKey), doc);
}

// In-process truth for "a generation is in flight" (#227): the gate reads this,
// never disk, so a crash can't leave a repo gated forever (markStaleGenerations
// clears any on-disk "generating" at startup).
const generating = new Set<string>();

export function isInstructionsGenerating(repoKey: string): boolean {
  return generating.has(repoKey);
}

// Ordered lookup of existing agent-instructions files in a linked repo (#241).
// First non-blank hit wins; generation is only the last resort. A whitespace-only
// file is a miss (an empty doc is useless — mirrors the generate path rejecting
// empty output), so the ladder falls through to the next candidate.
const SEED_LADDER: Array<{ file: string; source: RepoInstructionsSource }> = [
  { file: "CLAUDE.md", source: "claude-md" },
  { file: "AGENTS.md", source: "agents-md" },
  { file: join(".github", "copilot-instructions.md"), source: "copilot-instructions" },
  { file: "GEMINI.md", source: "gemini-md" },
];

async function readSeedFile(
  repoPath: string,
): Promise<{ content: string; source: RepoInstructionsSource } | null> {
  for (const { file, source } of SEED_LADDER) {
    let content: string;
    try {
      content = await readFile(join(repoPath, file), "utf-8");
    } catch {
      continue;
    }
    if (content.trim()) return { content, source };
  }
  return null;
}

export interface SeedRepoInstructionsArgs {
  dir: string;
  repoKey: string;
  /** Local checkout to seed from (instructions ladder) / generate against. */
  repoPath: string;
  /** Agentic generation, called only when the seed ladder finds nothing. */
  generate: () => Promise<string>;
  /** Fired once generation settles (resolve or reject) — the driver poke. */
  onSettled?: () => void;
  /** Regenerate: re-run the seeding decision even over a ready doc. */
  force?: boolean;
}

/**
 * Seed (or regenerate) a repo's instructions doc. Awaits only the synchronous
 * part — the seed-file copy, or the "generating" placeholder write — so the
 * caller can gate auto-planning before generation finishes. Generation runs
 * fire-and-forget; never throws (a generation failure lands as a "failed" doc so
 * planning proceeds without it).
 *
 * - Existing ready doc + no force: left untouched (relink preserves user edits).
 * - Seed ladder hit (CLAUDE.md → AGENTS.md → .github/copilot-instructions.md,
 *   first non-blank wins): copied with the matching source, status "ready".
 * - Otherwise: "generating" placeholder, then generate() in the background. On
 *   resolve/reject the write is guarded on the on-disk generationStartedAt still
 *   matching this run, so a concurrent user edit wins.
 */
export async function seedRepoInstructions(args: SeedRepoInstructionsArgs): Promise<void> {
  const { dir, repoKey, repoPath, generate, onSettled, force } = args;
  const existing = await loadRepoInstructions(dir, repoKey);
  if (!force && existing?.status === "ready") return;

  const seed = await readSeedFile(repoPath);
  if (seed !== null) {
    await saveRepoInstructions(dir, repoKey, {
      version: 1,
      content: seed.content,
      updatedAt: new Date().toISOString(),
      source: seed.source,
      status: "ready",
    });
    return;
  }

  const startedAt = new Date().toISOString();
  const priorContent = existing?.content ?? "";
  await saveRepoInstructions(dir, repoKey, {
    version: 1,
    content: "",
    updatedAt: startedAt,
    source: "generated",
    status: "generating",
    generationStartedAt: startedAt,
  });
  generating.add(repoKey);
  void (async () => {
    try {
      const text = (await generate()).trim();
      if (!text) throw new Error("generated repository conventions were empty");
      // A concurrent user edit clears generationStartedAt — it wins over this run.
      const onDisk = await loadRepoInstructions(dir, repoKey);
      if (onDisk?.generationStartedAt !== startedAt) return;
      await saveRepoInstructions(dir, repoKey, {
        version: 1,
        content: text,
        updatedAt: new Date().toISOString(),
        source: "generated",
        status: "ready",
      });
    } catch (err) {
      const onDisk = await loadRepoInstructions(dir, repoKey);
      if (onDisk?.generationStartedAt !== startedAt) return;
      await saveRepoInstructions(dir, repoKey, {
        version: 1,
        content: priorContent,
        updatedAt: new Date().toISOString(),
        source: "generated",
        status: "failed",
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      });
    } finally {
      generating.delete(repoKey);
      onSettled?.();
    }
  })();
}

/**
 * Flip any on-disk "generating" doc to "failed" (#227): the in-flight set never
 * survives a restart, so a doc left "generating" by a crash would gate planning
 * forever. Best-effort — a missing directory or unreadable file is skipped.
 */
export async function markStaleGenerations(dir: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const doc = await readDocFile(path);
    if (!doc || doc.status !== "generating") continue;
    await writeDocFile(path, {
      ...doc,
      status: "failed",
      error: "generation interrupted by app restart",
      updatedAt: new Date().toISOString(),
      generationStartedAt: undefined,
    });
  }
}

/** The injection read-path: the doc content only when it is ready and non-blank. */
export async function readReadyInstructions(
  dir: string,
  repoKey: string,
): Promise<string | undefined> {
  const doc = await loadRepoInstructions(dir, repoKey);
  if (doc?.status === "ready" && doc.content.trim()) return doc.content;
  return undefined;
}
