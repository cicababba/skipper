// Worktree lifecycle for the coding runner (issue #9). Pure Node module over
// runGit; callers inject paths. Lives in the public tree (open-core, #1/#18).

import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, normalize, sep } from "node:path";
import type { RepoRef, WorktreeFileChange, WorktreeFileContents } from "@nestbrain/shared";
import type { DiffStats } from "@nestbrain/core";
import { runGit } from "./git";
import { withAskpass } from "./repo-links";

function sanitize(component: string): string {
  return component.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** <root>/<owner>-<name>/issue-<N> — every component Windows-safe. */
export function worktreeDirFor(root: string, repo: RepoRef, issueNumber: number): string {
  return join(root, `${sanitize(repo.owner)}-${sanitize(repo.name)}`, `issue-${issueNumber}`);
}

/** Must match the reconcile PR-linking heuristic (reconcile.ts BRANCH_ISSUE_RE). */
export function branchFor(issueNumber: number): string {
  return `feature/issue-${issueNumber}`;
}

/** git fetch origin; on failure with a token, retry once under GIT_ASKPASS. */
export async function fetchOrigin(repoPath: string, token?: string | null): Promise<void> {
  const timeout = 300_000;
  const plain = await runGit(repoPath, ["fetch", "origin"], timeout);
  if (plain.code === 0) return;
  if (token) {
    const authed = await withAskpass(token, (env) =>
      runGit(repoPath, ["fetch", "origin"], timeout, env),
    );
    if (authed.code === 0) return;
    throw new Error(`git fetch failed: ${authed.stderr.trim() || plain.stderr.trim()}`);
  }
  throw new Error(`git fetch failed: ${plain.stderr.trim() || `exit ${plain.code}`}`);
}

/**
 * Base ref for new worktrees, e.g. "origin/main". Override wins; else
 * origin/HEAD via symbolic-ref; else ls-remote (needs network — a fetch
 * normally precedes this).
 */
export async function resolveBaseRef(repoPath: string, override?: string): Promise<string> {
  if (override) return override.startsWith("origin/") ? override : `origin/${override}`;
  const sym = await runGit(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0) {
    const ref = sym.stdout.trim().replace(/^refs\/remotes\//, "");
    if (ref) return ref;
  }
  const remote = await runGit(repoPath, ["ls-remote", "--symref", "origin", "HEAD"]);
  if (remote.code === 0) {
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(remote.stdout);
    if (match) return `origin/${match[1]}`;
  }
  throw new Error(
    `cannot resolve the default branch of origin: ${remote.stderr.trim() || sym.stderr.trim()}`,
  );
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const r = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) throw new Error(`git worktree list failed: ${r.stderr.trim()}`);
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
      worktrees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return worktrees;
}

function samePath(a: string, b: string): boolean {
  const na = resolve(normalize(a));
  const nb = resolve(normalize(b));
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export interface EnsureWorktreeResult {
  path: string;
  branch: string;
  created: boolean;
}

/**
 * Idempotent: an existing registration with the right branch is reused
 * (re-entry); a stale registration (dir gone) is pruned and re-added; an
 * existing branch is attached without -b; otherwise branch + worktree are
 * created from baseRef. Anything else (branch checked out elsewhere, ...)
 * throws with git's stderr.
 */
export async function ensureWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}): Promise<EnsureWorktreeResult> {
  const { repoPath, worktreePath, branch, baseRef } = opts;

  const existing = (await listWorktrees(repoPath)).find((w) => samePath(w.path, worktreePath));
  if (existing) {
    const alive = await stat(worktreePath).catch(() => null);
    if (alive?.isDirectory()) {
      if (existing.branch === branch) return { path: worktreePath, branch, created: false };
      throw new Error(
        `worktree ${worktreePath} is registered on branch "${existing.branch}", expected "${branch}"`,
      );
    }
    await runGit(repoPath, ["worktree", "prune"]);
  }

  const branchExists =
    (await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code ===
    0;
  const args = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, baseRef];
  const r = await runGit(repoPath, args, 120_000);
  if (r.code !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return { path: worktreePath, branch, created: true };
}

export interface WorktreeDiff {
  diff: string;
  stats: DiffStats;
}

/**
 * Uncommitted changes vs HEAD, for the agent review (#10). `git add -A -N`
 * (intent-to-add) makes untracked files appear in the diff without staging
 * content — safe in a disposable worktree the coder never commits in, and
 * the entries stay visible as unstaged new files for the #14 diff view.
 */
export async function captureWorktreeDiff(worktreePath: string): Promise<WorktreeDiff> {
  const intent = await runGit(worktreePath, ["add", "-A", "-N"]);
  if (intent.code !== 0) {
    throw new Error(`git add -N failed: ${intent.stderr.trim() || `exit ${intent.code}`}`);
  }
  return captureDiff(worktreePath, "HEAD");
}

/** Committed branch changes vs the base, for the post-merge memory capture (#11). */
export async function captureBranchDiff(
  worktreePath: string,
  baseRef: string,
): Promise<WorktreeDiff> {
  return captureDiff(worktreePath, `${baseRef}...HEAD`);
}

async function captureDiff(worktreePath: string, range: string): Promise<WorktreeDiff> {
  const numstat = await runGit(worktreePath, ["diff", range, "--numstat"]);
  if (numstat.code !== 0) {
    throw new Error(`git diff --numstat failed: ${numstat.stderr.trim() || `exit ${numstat.code}`}`);
  }
  const stats: DiffStats = { filesChanged: 0, totalChangedLines: 0, files: [] };
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    stats.filesChanged++;
    stats.files.push(pathParts.join("\t"));
    // binary files report "-\t-": count the file, contribute 0 lines
    stats.totalChangedLines += (parseInt(added, 10) || 0) + (parseInt(deleted, 10) || 0);
  }
  const patch = await runGit(worktreePath, ["diff", range]);
  if (patch.code !== 0) {
    throw new Error(`git diff failed: ${patch.stderr.trim() || `exit ${patch.code}`}`);
  }
  return { diff: patch.stdout, stats };
}

// Pre-PR diff review (#14): per-file worktree changes for the renderer.

const MAX_REVIEW_FILE_BYTES = 1024 * 1024;
const MAX_REVIEW_WRITE_BYTES = 5 * 1024 * 1024;

/**
 * Containment guard for renderer-supplied paths: rejects anything that is
 * empty, absolute, escapes the worktree, or touches .git/. Returns the
 * resolved absolute path.
 */
export function resolveInsideWorktree(worktreePath: string, relPath: string): string {
  if (!relPath.trim()) throw new Error("empty path");
  if (isAbsolute(relPath)) throw new Error(`absolute paths are not allowed: ${relPath}`);
  const root = resolve(normalize(worktreePath));
  const abs = resolve(root, normalize(relPath));
  const contained =
    process.platform === "win32"
      ? abs.toLowerCase().startsWith(root.toLowerCase() + sep)
      : abs.startsWith(root + sep);
  if (!contained) throw new Error(`path escapes the worktree: ${relPath}`);
  const rel = abs.slice(root.length + 1);
  const first = rel.split(sep)[0];
  if (first === ".git") throw new Error("access to .git/ is not allowed");
  return abs;
}

/** Parse `git diff --name-status -z -M` output. Exported for tests. */
export function parseNameStatusZ(stdout: string): WorktreeFileChange[] {
  const parts = stdout.split("\0");
  const changes: WorktreeFileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = parts[++i];
      const path = parts[++i];
      if (!path) break;
      changes.push(
        kind === "R" ? { path, oldPath, status: "renamed" } : { path, status: "added" },
      );
    } else {
      const path = parts[++i];
      if (!path) break;
      const mapped = kind === "A" ? "added" : kind === "D" ? "deleted" : "modified";
      changes.push({ path, status: mapped });
    }
  }
  return changes;
}

/** Changed files vs HEAD, intent-to-add first so untracked files appear (as captureWorktreeDiff). */
export async function listWorktreeChanges(worktreePath: string): Promise<WorktreeFileChange[]> {
  const intent = await runGit(worktreePath, ["add", "-A", "-N"]);
  if (intent.code !== 0) {
    throw new Error(`git add -N failed: ${intent.stderr.trim() || `exit ${intent.code}`}`);
  }
  const r = await runGit(worktreePath, ["diff", "HEAD", "--name-status", "-z", "-M"]);
  if (r.code !== 0) {
    throw new Error(`git diff --name-status failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return parseNameStatusZ(r.stdout);
}

function looksBinary(text: string): boolean {
  const len = Math.min(text.length, 8192);
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** HEAD blob + working-tree content of one changed file, capped and binary-checked. */
export async function readWorktreeFileVersions(
  worktreePath: string,
  relPath: string,
  oldPath?: string,
): Promise<WorktreeFileContents> {
  const abs = resolveInsideWorktree(worktreePath, relPath);
  const headPath = oldPath ?? relPath;
  if (oldPath) resolveInsideWorktree(worktreePath, oldPath);

  let original: string | null = null;
  let tooLarge = false;
  // cat-file -s first: distinguishes "not at HEAD" (→ null) from "too large".
  const size = await runGit(worktreePath, ["cat-file", "-s", `HEAD:${headPath}`]);
  if (size.code === 0) {
    if (parseInt(size.stdout.trim(), 10) > MAX_REVIEW_FILE_BYTES) {
      tooLarge = true;
    } else {
      const show = await runGit(worktreePath, ["show", `HEAD:${headPath}`]);
      if (show.code !== 0) {
        throw new Error(`git show failed: ${show.stderr.trim() || `exit ${show.code}`}`);
      }
      original = show.stdout;
    }
  }

  let modified: string | null = null;
  const st = await stat(abs).catch(() => null);
  if (st?.isFile()) {
    if (st.size > MAX_REVIEW_FILE_BYTES) {
      tooLarge = true;
    } else {
      modified = await readFile(abs, "utf-8");
    }
  }

  const binary = looksBinary(original ?? "") || looksBinary(modified ?? "");
  if (binary || tooLarge) return { original: null, modified: null, binary, tooLarge };
  return { original, modified, binary: false, tooLarge: false };
}

/** Write a user edit back into the worktree (existing changed files only — never creates paths). */
export async function writeWorktreeFile(
  worktreePath: string,
  relPath: string,
  content: string,
): Promise<void> {
  const abs = resolveInsideWorktree(worktreePath, relPath);
  if (Buffer.byteLength(content, "utf-8") > MAX_REVIEW_WRITE_BYTES) {
    throw new Error("content too large");
  }
  const st = await stat(abs).catch(() => null);
  if (!st?.isFile()) throw new Error(`not a file in the worktree: ${relPath}`);
  await writeFile(abs, content, "utf-8");
}

/** Stage everything and commit. `committed: false` when the tree was already clean. */
export async function commitWorktree(
  worktreePath: string,
  message: string,
): Promise<{ committed: boolean; sha: string }> {
  const add = await runGit(worktreePath, ["add", "-A"]);
  if (add.code !== 0) {
    throw new Error(`git add failed: ${add.stderr.trim() || `exit ${add.code}`}`);
  }
  const headSha = async (): Promise<string> => {
    const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    if (head.code !== 0) {
      throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim() || `exit ${head.code}`}`);
    }
    return head.stdout.trim();
  };

  const staged = await runGit(worktreePath, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return { committed: false, sha: await headSha() };

  let commit = await runGit(worktreePath, ["commit", "-m", message]);
  if (commit.code !== 0 && /tell me who you are|user\.(name|email)/i.test(commit.stderr + commit.stdout)) {
    commit = await runGit(worktreePath, [
      "-c",
      "user.name=NestBrain",
      "-c",
      "user.email=nestbrain@localhost",
      "commit",
      "-m",
      message,
    ]);
  }
  if (commit.code !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim() || `exit ${commit.code}`}`);
  }
  return { committed: true, sha: await headSha() };
}

/** git push -u origin <branch>; on failure with a token, retry once under GIT_ASKPASS. */
export async function pushWorktreeBranch(
  worktreePath: string,
  branch: string,
  token?: string | null,
): Promise<void> {
  const timeout = 300_000;
  const args = ["push", "-u", "origin", branch];
  const plain = await runGit(worktreePath, args, timeout);
  if (plain.code === 0) return;
  let last = plain;
  if (token) {
    const authed = await withAskpass(token, (env) => runGit(worktreePath, args, timeout, env));
    if (authed.code === 0) return;
    last = authed;
  }
  const stderr = last.stderr.trim() || plain.stderr.trim() || `exit ${last.code}`;
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(stderr)) {
    throw new Error(`push rejected (non-fast-forward): the remote branch changed — ${stderr}`);
  }
  throw new Error(`git push failed: ${stderr}`);
}

/** Kept for #11 post-merge cleanup and future UI — nothing calls it in #9. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const r = await runGit(repoPath, ["worktree", "remove", "--force", worktreePath]);
  if (r.code !== 0) throw new Error(`git worktree remove failed: ${r.stderr.trim()}`);
  await runGit(repoPath, ["worktree", "prune"]);
}
