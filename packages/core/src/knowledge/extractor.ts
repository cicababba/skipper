// Extract KnowledgeAtoms from a single git commit.
//
// The extractor reads the commit's metadata + diff via plain `git` invocations
// (no libgit dep — works wherever git is on PATH) and asks an LLM to surface
// the REUSABLE insight(s) in that change. The model is told to be picky: most
// commits don't carry an atom, and we'd rather miss a few than pollute the
// knowledge base.

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { LLMProviderInterface } from "../llm/provider";
import { slugify, type KnowledgeAtom, type SourceRef } from "./atom";

/** Max diff bytes we hand to the LLM. Beyond this we truncate per-file. */
const MAX_DIFF_BYTES = 60_000;
const PER_FILE_HEAD_BYTES = 6_000;

export interface ExtractOptions {
  repoPath: string;
  commitSha: string;
  /** Project name to tag atoms with. Defaults to basename of repoPath. */
  projectName?: string;
  llm: LLMProviderInterface;
}

export interface ExtractedCandidate {
  title: string;
  body: string;
  tags: string[];
  score: number;
  files: string[]; // touched files the insight refers to
}

interface CommitInfo {
  sha: string;
  shortSha: string;
  date: string; // YYYY-MM-DD
  subject: string;
  body: string;
  files: { path: string; status: string }[];
  diff: string;
}

/** Read commit metadata + diff. Throws if SHA is invalid or repo unreadable. */
export function readCommit(repoPath: string, sha: string): CommitInfo {
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    }).trim();

  // Resolve to full SHA (rejects bad input early).
  const fullSha = git(["rev-parse", "--verify", `${sha}^{commit}`]);
  const shortSha = git(["rev-parse", "--short", fullSha]);
  const date = git(["log", "-1", "--format=%cs", fullSha]); // committer date short (YYYY-MM-DD)
  const subject = git(["log", "-1", "--format=%s", fullSha]);
  const body = git(["log", "-1", "--format=%b", fullSha]);

  const nameStatus = git(["show", "--name-status", "--format=", fullSha]);
  const files: { path: string; status: string }[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split("\t");
    const path = rest.join("\t"); // handle rename (R100\told\tnew) by keeping the joined string
    if (path) files.push({ status, path });
  }

  // Diff, with per-file truncation so a single huge file doesn't blow the budget.
  const rawDiff = git(["show", "--format=", fullSha]);
  const diff = truncateDiff(rawDiff);

  return { sha: fullSha, shortSha, date, subject, body, files, diff };
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_BYTES) return diff;
  // Split on the per-file `diff --git` header so we can keep the head of
  // each file's hunk rather than chop the tail of the whole thing.
  const parts = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    const slice = part.length > PER_FILE_HEAD_BYTES
      ? part.slice(0, PER_FILE_HEAD_BYTES) + "\n…[truncated]…\n"
      : part;
    if (used + slice.length > MAX_DIFF_BYTES) break;
    kept.push(slice);
    used += slice.length;
  }
  return kept.join("");
}

const SYSTEM_PROMPT = `You are Skipper's knowledge extractor. You read a single git commit and identify REUSABLE INSIGHTS that would be worth recalling on a different project months from now.

Reusable means: a pattern, a workaround, a non-obvious decision, a constraint you discovered, a gotcha, an architectural rationale. Examples: "Drive 'desktop app' OAuth secrets are non-confidential — PKCE is the real security", "chokidar 3 stays on CJS, 4+ are ESM-only", "Google Drive Changes API + page token replaces O(N) walks".

NOT reusable: implementation specifics tied to this codebase, "fixed a typo", "bumped version", "renamed variable", refactors with no architectural delta, dependency upgrades unless they expose a non-obvious migration step.

For each insight, write a short atom (Markdown body, 3–8 lines, no headings, no preamble) that another engineer (or another AI on a different project) could read and apply.

Score 0–10 by reusability:
- 0–2: trivial / project-specific / not really an insight
- 3–5: useful but narrow
- 6–8: solid pattern worth remembering
- 9–10: foundational principle that changes how you'd approach a class of problem

Most commits produce 0 atoms. Many produce 1. Some produce 2–3. Never invent — if the commit is mechanical, return [].

You MUST output JSON matching the schema. No prose outside the JSON.`;

function buildUserPrompt(c: CommitInfo): string {
  const fileList = c.files
    .map((f) => `${f.status}\t${f.path}`)
    .join("\n");
  return [
    `Commit: ${c.shortSha}  Date: ${c.date}`,
    `Subject: ${c.subject}`,
    "",
    "Body:",
    c.body || "(empty)",
    "",
    "Files changed:",
    fileList || "(none)",
    "",
    "Diff:",
    c.diff || "(no diff)",
  ].join("\n");
}

const ATOMS_SCHEMA = {
  type: "object",
  properties: {
    atoms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Sharp, declarative; lead with the insight, not the change." },
          body: { type: "string", description: "3–8 line markdown explaining the insight + when it applies. No headings." },
          tags: { type: "array", items: { type: "string" }, description: "3–6 short tags." },
          score: { type: "number", minimum: 0, maximum: 10 },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Subset of the changed files this atom refers to.",
          },
        },
        required: ["title", "body", "tags", "score", "files"],
      },
    },
  },
  required: ["atoms"],
} as const;

/**
 * Run the LLM on a single commit and return all proposed atoms (regardless
 * of score — filtering / queueing happens in the queue layer).
 */
export async function extractFromCommit(opts: ExtractOptions): Promise<KnowledgeAtom[]> {
  const info = readCommit(opts.repoPath, opts.commitSha);
  const project = opts.projectName ?? basename(opts.repoPath);

  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserPrompt(info)}`;
  const result = await opts.llm.askStructured<{ atoms: ExtractedCandidate[] }>(
    prompt,
    ATOMS_SCHEMA as unknown as Record<string, unknown>,
  );

  const atoms: KnowledgeAtom[] = [];
  for (const c of result.atoms ?? []) {
    if (!c.title || !c.body) continue;
    const id = slugify(c.title);
    if (!id) continue;
    const sourceRefs: SourceRef[] = [{ commit: info.shortSha }];
    for (const f of c.files ?? []) {
      if (!f) continue;
      sourceRefs.push({ commit: info.shortSha, file: f });
    }
    atoms.push({
      id,
      title: c.title.trim(),
      project,
      created: info.date,
      score: clampScore(c.score),
      tags: (c.tags ?? []).map((t) => t.trim()).filter(Boolean),
      sourceRefs,
      body: c.body.trim(),
    });
  }
  return atoms;
}

function clampScore(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, Math.round(v)));
}
