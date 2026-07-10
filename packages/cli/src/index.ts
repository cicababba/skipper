#!/usr/bin/env node

import { Command } from "commander";
import { basename, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createProvider,
  extractFromCommit,
  writePendingAtom,
  listPending,
  acceptAtom,
  rejectAtom,
  updatePendingAtom,
  parseAtom,
  installHook,
  uninstallHook,
  getHookStatus,
  slugify,
} from "@nestbrain/core";
import type { LLMProviderInterface } from "@nestbrain/core";
import { readFile } from "node:fs/promises";
import { saveSession, resumeSession } from "./session.js";

const program = new Command();

// Injected at bundle time by build/bundle.mjs via esbuild's `define`.
// In a non-bundled `tsc`-built run we fall back to a sentinel so the
// command still works in dev.
declare const __NESTBRAIN_CLI_VERSION__: string;
const CLI_VERSION = typeof __NESTBRAIN_CLI_VERSION__ !== "undefined" ? __NESTBRAIN_CLI_VERSION__ : "dev";

/**
 * Look up the NestBrain workspace path the Electron app persists in its
 * bootstrap file. This is the canonical "where is my workspace" pointer
 * for installed users — set once during onboarding and updated whenever
 * the user moves their NestBrain folder via Settings.
 *
 * On macOS: ~/Library/Application Support/NestBrain/bootstrap.json
 * On Windows: %APPDATA%/NestBrain/bootstrap.json
 * On Linux: ~/.config/NestBrain/bootstrap.json
 */
function readElectronBootstrapWorkspace(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(resolve(home, "Library/Application Support/NestBrain/bootstrap.json"));
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) candidates.push(resolve(appData, "NestBrain/bootstrap.json"));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || resolve(home, ".config");
    candidates.push(resolve(xdg, "NestBrain/bootstrap.json"));
  }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const data = require(p) as { nestBrainPath?: string };
      if (data.nestBrainPath && existsSync(resolve(data.nestBrainPath, ".nestbrain"))) {
        return data.nestBrainPath;
      }
    } catch {
      /* skip unreadable */
    }
  }
  return null;
}

/**
 * Walk up from `start` looking for a `.nestbrain/` directory. Returns the
 * containing dir (the workspace root) or null.
 */
function findWorkspaceAbove(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (existsSync(resolve(dir, ".nestbrain"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

interface WorkspaceSettings {
  llm?: {
    provider?: "claude-cli" | "openai" | "ollama";
    openaiApiKey?: string;
    openaiModel?: string;
    claudeModel?: string;
    ollamaModel?: string;
  };
  autoExtractAtoms?: boolean;
}

/** Read the app Settings (provider/model + flags) from the workspace. */
function loadWorkspaceSettings(workspace?: string): WorkspaceSettings | null {
  try {
    const ws = workspace ?? resolveWorkspace();
    const p = resolve(ws, ".nestbrain", "settings.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as WorkspaceSettings;
  } catch {
    return null;
  }
}

// Resolve the LLM from the workspace Settings — the provider + model the user
// picked in the app. Falls back to the claude-cli default when there are no
// settings (e.g. a bare CLI checkout with no app workspace).
function getLLM(workspace?: string): LLMProviderInterface {
  const llm = loadWorkspaceSettings(workspace)?.llm;
  if (llm?.provider) {
    const model =
      llm.provider === "claude-cli"
        ? llm.claudeModel || process.env.NESTBRAIN_MODEL || "sonnet"
        : llm.provider === "ollama"
          ? llm.ollamaModel || ""
          : llm.openaiModel || "gpt-4o";
    return createProvider({
      provider: llm.provider,
      model,
      maxTurns: 5,
      apiKey: llm.provider === "openai" ? llm.openaiApiKey || process.env.OPENAI_API_KEY : undefined,
    });
  }
  return createProvider({
    provider: "claude-cli",
    model: process.env.NESTBRAIN_MODEL ?? "sonnet",
    maxTurns: 5,
    apiKey: process.env.OPENAI_API_KEY,
  });
}

program
  .name("nestbrain")
  .description("LLM-powered personal knowledge base")
  .version(CLI_VERSION);

// ---------- knowledge subcommands ----------

const knowledge = program
  .command("knowledge")
  .description("Project knowledge atom pipeline (extract from commits, review, accept/reject)");

function resolveWorkspace(opt?: string): string {
  if (opt) return resolve(opt);
  const walked = findWorkspaceAbove(process.cwd());
  if (walked) return walked;
  const fromBootstrap = readElectronBootstrapWorkspace();
  if (fromBootstrap) return fromBootstrap;
  // Last resort — ensureQueueDirs will populate `.nestbrain/` under cwd.
  return process.cwd();
}

function detectProjectName(repoPath: string, override?: string): string {
  if (override) return override;
  try {
    const root = execFileSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
    return basename(root);
  } catch {
    return basename(repoPath);
  }
}

knowledge
  .command("extract <sha>")
  .description("Extract knowledge atoms from a git commit into the pending queue")
  .option("-r, --repo <path>", "Repository path (default: current dir)", process.cwd())
  .option("-w, --workspace <path>", "NestBrain workspace path (default: auto-detect via .nestbrain)")
  .option("-p, --project <name>", "Project tag (default: git repo basename)")
  .action(async (sha, options) => {
    try {
      const repoPath = resolve(options.repo);
      const workspace = resolveWorkspace(options.workspace);
      const projectName = detectProjectName(repoPath, options.project);
      if (loadWorkspaceSettings(workspace)?.autoExtractAtoms === false) {
        console.log("  (auto-atom extraction disabled in settings — skipping)");
        return;
      }
      const llm = getLLM(workspace);
      console.log(`Extracting from ${sha} (project: ${projectName})…`);
      const atoms = await extractFromCommit({
        repoPath,
        commitSha: sha,
        projectName,
        llm,
      });
      if (atoms.length === 0) {
        console.log("  (no atoms proposed — commit looks mechanical)");
        return;
      }
      for (const atom of atoms) {
        const file = await writePendingAtom(workspace, atom);
        const marker = atom.score >= 7 ? "★" : atom.score >= 4 ? "·" : "○";
        console.log(`  ${marker} [score ${atom.score}] ${atom.title}`);
        console.log(`         → ${file}`);
      }
      console.log(`\n✓ ${atoms.length} atom(s) in pending queue. Run \`nestbrain knowledge review\` to triage.`);
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

knowledge
  .command("list")
  .description("List atoms in the pending queue")
  .option("-w, --workspace <path>", "NestBrain workspace path (default: auto-detect)")
  .action(async (options) => {
    try {
      const workspace = resolveWorkspace(options.workspace);
      const entries = await listPending(workspace);
      if (entries.length === 0) {
        console.log("(pending queue is empty)");
        return;
      }
      for (const e of entries) {
        const marker = e.atom.score >= 7 ? "★" : e.atom.score >= 4 ? "·" : "○";
        console.log(`  ${marker} [${e.atom.score}] ${e.atom.title}`);
        console.log(`         ${e.atom.project} · ${e.atom.created} · tags: ${e.atom.tags.join(", ")}`);
      }
      console.log(`\n${entries.length} pending.`);
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

knowledge
  .command("review")
  .description("Interactively triage pending atoms (a accept · r reject · e edit · s skip · q quit)")
  .option("-w, --workspace <path>", "NestBrain workspace path (default: auto-detect)")
  .option("--min-score <n>", "Only show atoms with score >= n", "0")
  .action(async (options) => {
    try {
      const workspace = resolveWorkspace(options.workspace);
      const minScore = Math.max(0, Math.min(10, parseInt(options.minScore, 10) || 0));
      let entries = (await listPending(workspace)).filter((e) => e.atom.score >= minScore);
      if (entries.length === 0) {
        console.log("(nothing to review)");
        return;
      }
      const rl = createInterface({ input, output });
      const reload = async () => {
        entries = (await listPending(workspace)).filter((e) => e.atom.score >= minScore);
      };
      let acceptedN = 0,
        rejectedN = 0,
        editedN = 0,
        skippedN = 0;
      try {
        let i = 0;
        while (i < entries.length) {
          const e = entries[i];
          console.log("\n" + "─".repeat(72));
          console.log(`[${i + 1}/${entries.length}]  score ${e.atom.score}  ·  ${e.atom.project}  ·  ${e.atom.created}`);
          console.log(`title: ${e.atom.title}`);
          console.log(`tags : ${e.atom.tags.join(", ") || "(none)"}`);
          console.log(`refs : ${e.atom.sourceRefs.map((r) => r.commit + (r.file ? ` (${r.file})` : "")).join(", ")}`);
          console.log("");
          console.log(e.atom.body);
          console.log("─".repeat(72));
          const choice = (await rl.question("[a]ccept · [r]eject · [e]dit · [s]kip · [q]uit · [?] help > ")).trim().toLowerCase();
          if (choice === "a" || choice === "accept") {
            const dest = await acceptAtom(workspace, e);
            console.log(`✓ accepted → ${dest}`);
            acceptedN++;
            i++;
          } else if (choice === "r" || choice === "reject") {
            const dest = await rejectAtom(workspace, e);
            console.log(`✗ rejected → ${dest}`);
            rejectedN++;
            i++;
          } else if (choice === "e" || choice === "edit") {
            const editor = process.env.EDITOR || "vi";
            const r = spawnSync(editor, [e.filePath], { stdio: "inherit" });
            if (r.status === 0) {
              // Re-read and refresh the entry so subsequent display reflects edits.
              try {
                const text = await readFile(e.filePath, "utf-8");
                const updated = parseAtom(text);
                if (updated) {
                  const nextPath = await updatePendingAtom(e.filePath, updated);
                  entries[i] = { filePath: nextPath, atom: updated };
                  editedN++;
                  console.log("✎ edited — review again or accept/reject");
                  continue; // don't advance; user re-decides
                }
              } catch {
                console.log("(couldn't re-read edited atom — moving on)");
              }
            }
            i++;
          } else if (choice === "s" || choice === "skip" || choice === "") {
            skippedN++;
            i++;
          } else if (choice === "q" || choice === "quit") {
            break;
          } else if (choice === "?" || choice === "h" || choice === "help") {
            console.log("a=accept · r=reject · e=edit ($EDITOR) · s=skip · q=quit");
          } else {
            console.log("(unknown — try ?)");
          }
        }
      } finally {
        rl.close();
      }
      console.log(`\nSummary: ${acceptedN} accepted, ${rejectedN} rejected, ${editedN} edited, ${skippedN} skipped`);
      void reload;
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

knowledge
  .command("promote")
  .description(
    "Add a manually-curated atom to the pending queue (reads JSON from stdin). " +
      "Used by the promote-knowledge skill as the escape hatch for insights that " +
      "aren't tied to a git commit.",
  )
  .option("-w, --workspace <path>", "NestBrain workspace path (default: auto-detect)")
  .action(async (options) => {
    try {
      const workspace = resolveWorkspace(options.workspace);
      const raw = await new Promise<string>((resolveStdin, rejectStdin) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => {
          data += chunk;
        });
        process.stdin.on("end", () => resolveStdin(data));
        process.stdin.on("error", rejectStdin);
      });
      if (!raw.trim()) {
        throw new Error(
          "No input on stdin. Pipe a JSON object: {title, body, project, tags?, score?}",
        );
      }
      const payload = JSON.parse(raw);
      const title = String(payload.title ?? "").trim();
      const body = String(payload.body ?? "").trim();
      const project = String(payload.project ?? "").trim();
      if (!title) throw new Error("`title` is required");
      if (!body) throw new Error("`body` is required");
      if (!project) throw new Error("`project` is required");

      const id = slugify(title);
      if (!id) throw new Error("Title produced an empty slug — pick a more specific title");
      const today = new Date().toISOString().slice(0, 10);
      const scoreRaw = Number(payload.score ?? 7);
      const score = Number.isFinite(scoreRaw)
        ? Math.max(0, Math.min(10, Math.round(scoreRaw)))
        : 7;
      const tags = Array.isArray(payload.tags)
        ? payload.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];

      const file = await writePendingAtom(workspace, {
        id,
        title,
        project,
        created: today,
        score,
        tags,
        sourceRefs: [],
        body,
      });
      console.log(`✓ ${title}`);
      console.log(`  → ${file}`);
      console.log(`  Open NestBrain → Knowledge to accept it.`);
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// ---------- project registration (post-commit hook) ----------

const projects = program
  .command("projects")
  .description("Manage projects that auto-feed the knowledge base");

function detectCliCommand(override?: string): string {
  if (override) return override;
  // Prefer a globally-installed `nestbrain` on PATH so hooks survive working-
  // tree moves / dev sources being deleted.
  try {
    execSync("command -v nestbrain", { stdio: "pipe" });
    return "nestbrain";
  } catch {
    // Dev fallback: invoke this very source file via tsx.
    const devEntry = resolve(__dirname, "../src/index.ts");
    if (existsSync(devEntry)) {
      return `npx tsx ${devEntry}`;
    }
    throw new Error(
      "No `nestbrain` on PATH and no dev source detected. Pass --cli '<command>' explicitly.",
    );
  }
}

projects
  .command("register")
  .description("Install the post-commit hook that auto-extracts knowledge atoms")
  .option("-r, --repo <path>", "Repository path (default: cwd)", process.cwd())
  .option("--cli <command>", "Command the hook should invoke (default: auto-detect)")
  .action((options) => {
    try {
      const repoPath = resolve(options.repo);
      const cliCommand = detectCliCommand(options.cli);
      const result = installHook({ repoPath, cliCommand });
      console.log(`${result.replaced ? "✓ Updated" : "✓ Installed"}: ${result.hookPath}`);
      console.log(`  CLI: ${cliCommand}`);
      console.log("  Atoms will land in <workspace>/.nestbrain/knowledge-pending/ after every commit.");
      console.log("  Run `nestbrain knowledge review` to triage.");
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

projects
  .command("unregister")
  .description("Remove the post-commit hook installed by `register`")
  .option("-r, --repo <path>", "Repository path (default: cwd)", process.cwd())
  .action((options) => {
    try {
      const repoPath = resolve(options.repo);
      const result = uninstallHook(repoPath);
      if (result.removed) {
        console.log(`✓ Removed nestbrain snippet from ${result.hookPath}`);
      } else {
        console.log(`(no nestbrain snippet found in ${result.hookPath})`);
      }
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

projects
  .command("status")
  .description("Show whether the post-commit hook is installed in this repo")
  .option("-r, --repo <path>", "Repository path (default: cwd)", process.cwd())
  .action((options) => {
    try {
      const repoPath = resolve(options.repo);
      const s = getHookStatus(repoPath);
      console.log(`Hook path: ${s.hookPath}`);
      console.log(`Exists:    ${s.exists ? "yes" : "no"}`);
      console.log(`Managed:   ${s.ours ? `yes (v${s.version})` : "no"}`);
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// ===== Session handoff (cross-machine) =====
const session = program
  .command("session")
  .description("Cross-machine session handoff: capture a project's state to resume elsewhere");

session
  .command("save")
  .description("Create or enrich the project's session summary (compresses changes since the last save)")
  .option("-p, --project <path>", "Project directory (default: current dir)", process.cwd())
  .action(async (options) => {
    try {
      const dir = resolve(options.project);
      const llm = getLLM(resolveWorkspace());
      const path = await saveSession(dir, { llm, log: (m) => console.log(m) });
      console.log(`\n✔ Session summary saved → ${path}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

session
  .command("resume")
  .description("Print a resumption briefing from the project's session summary (run on the machine taking over)")
  .option("-p, --project <path>", "Project directory (default: current dir)", process.cwd())
  .action(async (options) => {
    try {
      const dir = resolve(options.project);
      const llm = getLLM(resolveWorkspace());
      // Progress goes to stderr so stdout is a clean briefing the caller can pipe.
      const briefing = await resumeSession(dir, { llm, log: (m) => console.error(m) });
      console.log(briefing);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

program.parse();
