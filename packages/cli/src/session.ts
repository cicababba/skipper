// Cross-machine session handoff: capture a project's working state into a
// summary another machine (or a fresh Claude Code session) can resume from.
//
//   save   — create the summary if absent, else ENRICH it with a compressed
//            delta of everything new since the last save (git-log driven).
//   resume — read the summary and produce a resumption briefing so a fresh
//            assistant continues where the last session left off.
//
// The summary lives at <project>/session-summary.md — the PROJECT ROOT, not a
// dot-dir, because the sync engines skip dot-dirs (`.nest/` never travels to
// another machine). A "Project Brief" kept current across saves, plus a
// "Session Log" of dated compressed deltas. Reads also fall back to the legacy
// .nest/ location so older summaries aren't orphaned.

import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import type { AgentRuntime, LLMProviderInterface } from "@skipper/core";

const SUMMARY_REL = "session-summary.md";
const LEGACY_REL = join(".nest", "session-summary.md");

/** Existing summary path: prefer the synced root file, else the legacy .nest/. */
function existingSummaryPath(dir: string): string | null {
  const root = join(dir, SUMMARY_REL);
  if (existsSync(root)) return root;
  const legacy = join(dir, LEGACY_REL);
  if (existsSync(legacy)) return legacy;
  return null;
}
const MAX_DELTA = 18000;
const MAX_TREE = 500;

interface Frontmatter {
  project: string;
  created: string;
  updated: string;
  lastCommit?: string;
  sessions: number;
}

function gitOk(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

function nowISO(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ") + "Z";
}

/** Split YAML frontmatter from the markdown body. */
function parseSummary(text: string): { fm: Partial<Frontmatter>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Partial<Frontmatter> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === "sessions") fm.sessions = parseInt(v) || 0;
    else (fm as Record<string, string>)[k] = v.replace(/^["']|["']$/g, "");
  }
  return { fm, body: m[2].trim() };
}

function render(fm: Frontmatter, body: string): string {
  return (
    `---\n` +
    `project: "${fm.project}"\n` +
    `created: ${fm.created}\n` +
    `updated: ${fm.updated}\n` +
    (fm.lastCommit ? `lastCommit: ${fm.lastCommit}\n` : "") +
    `sessions: ${fm.sessions}\n` +
    `---\n\n` +
    body.trim() +
    "\n"
  );
}

/** Best-effort file listing for a non-git project. */
async function listFiles(dir: string, prefix = "", out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 4 || out.length > MAX_TREE) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length > MAX_TREE) break;
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) await listFiles(join(dir, e.name), rel, out, depth + 1);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

async function readHead(dir: string, name: string, max = 4000): Promise<string> {
  for (const f of [name, name.toUpperCase(), name.toLowerCase()]) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try {
        return (await readFile(p, "utf8")).slice(0, max);
      } catch {
        /* ignore */
      }
    }
  }
  return "";
}

const SYS_SAVE =
  "You are a senior engineer writing the definitive handoff doc so another engineer (or AI) can take over this project on a " +
  "different machine and be productive immediately — as if they'd been working on it all along.\n\n" +
  "You have file reading, search and shell tools. USE THEM: actually explore the repo before writing — read the entry points, the " +
  "build/config files (package.json, *.xcodeproj/project.pbxproj, Cargo.toml, pyproject, etc.), the main modules, the README, " +
  "and recent diffs. Do not guess from filenames.\n\n" +
  "Then write a DENSE, concrete brief covering:\n" +
  "• WHAT THE APP DOES — the product, for the user: what it is, what it's for, the core features and how they behave. Be specific.\n" +
  "• HOW TO BUILD & RUN it (exact commands / targets / requirements).\n" +
  "• ARCHITECTURE — the big picture and where each part lives, with real file paths. The key modules and their responsibilities, " +
  "the data flow, important types/abstractions, external deps/services.\n" +
  "• CURRENT STATE — what works, what's half-done, the active branch, known issues.\n" +
  "• CONVENTIONS & GOTCHAS — non-obvious decisions, traps, things that will bite a newcomer.\n" +
  "• NEXT STEPS — concrete, prioritized.\n\n" +
  "No fluff, no preamble, no 'this appears to be'. Write what you VERIFIED from the code. Markdown.";

export interface SessionDeps {
  llm: LLMProviderInterface;
  /** Agent runtime (#238); when present the model reads the real code in `cwd`. */
  runtime?: AgentRuntime;
  log: (m: string) => void;
}

/** Prefer the agentic path (the model reads the real code in `cwd`); fall back
 *  to a single-turn completion when there is no runtime. */
async function complete(
  llm: LLMProviderInterface,
  runtime: AgentRuntime | undefined,
  prompt: string,
  opts: { cwd: string; system: string; turns?: number },
): Promise<string> {
  if (runtime) {
    return (
      await runtime.agent(prompt, { cwd: opts.cwd, systemPrompt: opts.system, maxTurns: opts.turns ?? 40 })
    ).text.trim();
  }
  return (await llm.ask(prompt, opts.system)).text.trim();
}

export async function saveSession(projectDir: string, { llm, runtime, log }: SessionDeps): Promise<string> {
  const dir = resolve(projectDir);
  const name = basename(dir);
  const path = join(dir, SUMMARY_REL); // always write to the synced root file
  const existPath = existingSummaryPath(dir);
  const existing = existPath ? await readFile(existPath, "utf8") : null;
  const prev = existing ? parseSummary(existing) : null;

  const isGit = gitOk(dir);
  const head = isGit ? git(dir, ["rev-parse", "HEAD"]) : "";

  const recent = isGit ? git(dir, ["log", "--oneline", "-30"]) : "";
  let body: string;
  if (!prev) {
    log(`Exploring "${name}" and writing the session summary (reading the code)…`);
    const prompt =
      `Explore the project in the current directory ("${name}") and write its "Project Brief".\n\n` +
      `Read the entry points, build/config files, the main source modules and the README — verify what the app DOES and how ` +
      `it's built from the actual code, don't guess.\n\n` +
      (recent ? `Recent commits for context:\n${recent}\n\n` : "") +
      `Output ONLY the brief body (markdown), no preamble — it becomes the durable "## Project Brief" section.`;
    let brief = await complete(llm, runtime, prompt, { cwd: dir, system: SYS_SAVE });
    // Drop any chain-of-thought preamble before the first heading, and a
    // leading "Project Brief" heading (we add our own).
    brief = (brief.replace(/^[\s\S]*?(?=^#{1,6}\s)/m, "").trim() || brief.trim())
      .replace(/^#{1,6}\s*Project Brief[^\n]*\n+/i, "")
      .trim();
    body = `# Session summary — ${name}\n\n## Project Brief\n\n${brief}\n\n## Session Log\n`;
  } else {
    const last = prev.fm.lastCommit;
    const delta =
      isGit && last && head && last !== head
        ? git(dir, ["log", "--stat", "--no-color", `${last}..HEAD`]).slice(0, MAX_DELTA)
        : "";
    if (!delta && last === head) {
      log("No new commits since the last summary — re-verifying against the code.");
    }
    log(`Enriching the summary for "${name}" (reading the changed code, compressing the delta)…`);
    const prompt =
      `This is the existing handoff for the project in the current directory ("${name}"):\n\n${prev.body}\n\n` +
      (delta
        ? `New changes since the last summary (git log --stat ${last?.slice(0, 8)}..HEAD):\n${delta}\n\n` +
          `READ the changed files to understand them properly.\n\n`
        : `There are no new git commits since the last summary; re-verify the brief against the current code.\n\n`) +
      `Return the FULL updated summary in markdown with exactly these sections:\n` +
      `## Project Brief — kept CURRENT and just as detailed as before (fold in anything the changes altered; keep WHAT THE APP DOES, build/run, architecture with file paths, state, gotchas, next steps).\n` +
      `## Session Log — keep all prior entries verbatim, and PREPEND one new entry dated ${nowISO()} that COMPRESSES what changed this session (the essence of the new work, decisions, and where it leaves off).\n` +
      `Be concrete and dense. Do not invent changes that aren't in the delta or the code.`;
    body = await complete(llm, runtime, prompt, { cwd: dir, system: SYS_SAVE });
    body = body.replace(/^[\s\S]*?(?=^#{1,6}\s)/m, "").trim() || body.trim();
  }

  const fm: Frontmatter = {
    project: name,
    created: prev?.fm.created ?? nowISO(),
    updated: nowISO(),
    lastCommit: head || prev?.fm.lastCommit,
    sessions: (prev?.fm.sessions ?? 0) + 1,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, render(fm, body), "utf8");
  return path;
}

const SYS_RESUME =
  "You brief an engineer (or AI assistant) about to resume a project on THIS machine. You have the handoff summary plus file " +
  "reading, search and shell tools — use them to ground the briefing in the CURRENT code in this directory (and reconcile any noted " +
  "divergence between the summary and the local checkout). Produce a tight, concrete resumption briefing: what the app does, " +
  "how to build/run it, the current state, what was in progress, the EXACT next steps, the key files to open (with paths), and " +
  "the gotchas — so they continue as if they never left. No preamble. Markdown.";

export async function resumeSession(projectDir: string, { llm, runtime }: SessionDeps): Promise<string> {
  const dir = resolve(projectDir);
  const path = existingSummaryPath(dir);
  if (!path) {
    throw new Error(
      `no ${SUMMARY_REL} in this project — run \`skipper session save\` on the other machine (and let it sync) first`,
    );
  }
  const { fm, body } = parseSummary(await readFile(path, "utf8"));
  const isGit = gitOk(dir);
  const head = isGit ? git(dir, ["rev-parse", "HEAD"]) : "";
  const diverged = fm.lastCommit && head && fm.lastCommit !== head;
  const localChanges = diverged ? git(dir, ["log", "--oneline", `${fm.lastCommit}..HEAD`]).slice(0, 4000) : "";

  const prompt =
    `Handoff summary for project "${fm.project}" (last saved ${fm.updated}):\n\n${body}\n\n` +
    (diverged
      ? `NOTE: this machine's checkout has moved past the summary's commit ${fm.lastCommit?.slice(0, 8)}.\n` +
        (localChanges ? `Local commits not reflected in the summary:\n${localChanges}\n\n` : `\n`)
      : `The local checkout matches the summary's commit.\n\n`) +
    `Verify the key claims against the current code in this directory, then produce the resumption briefing.`;
  return await complete(llm, runtime, prompt, { cwd: dir, system: SYS_RESUME, turns: 30 });
}

export function sessionSummaryPath(projectDir: string): string {
  return existingSummaryPath(resolve(projectDir)) ?? join(resolve(projectDir), SUMMARY_REL);
}
