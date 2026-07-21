// Per-repo link between a code-host owner/name and a local clone, persisted as
// plain JSON in userData. Pure Node module (no electron import) so it stays
// unit-testable; callers inject the file path and the CodeHost adapter.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { RepoRef } from "@skipper/shared";
import type { CodeHost, PushCredentials } from "@skipper/core";

export interface RepoLink {
  localPath: string;
  linkedAt: string; // ISO 8601
  /** Overrides origin/HEAD as the coding base branch (#9). Hand-edited for now; UI later. */
  baseBranch?: string;
}

export interface RepoLinksFile {
  version: 1;
  /** repoKey(repo) → link */
  repos: Record<string, RepoLink>;
}

function freshLinksFile(): RepoLinksFile {
  return { version: 1, repos: {} };
}

export async function loadRepoLinks(filePath: string): Promise<RepoLinksFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as RepoLinksFile;
    if (parsed.version === 1 && typeof parsed.repos === "object" && parsed.repos !== null) {
      return parsed;
    }
    return freshLinksFile();
  } catch {
    return freshLinksFile();
  }
}

// Serialized saves so concurrent link/clone calls never race the write+rename.
const saveQueue = new Map<string, Promise<void>>();

export async function saveRepoLinks(filePath: string, links: RepoLinksFile): Promise<void> {
  const bytes = JSON.stringify(links, null, 2);
  const prev = saveQueue.get(filePath) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* swallow previous error so this save still runs */
    })
    .then(() => writeAtomic(filePath, bytes));
  saveQueue.set(filePath, next);
  try {
    await next;
  } finally {
    if (saveQueue.get(filePath) === next) saveQueue.delete(filePath);
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, "utf-8");
  await rename(tmp, path);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<RunResult> {
  return new Promise((res) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        const code = error
          ? (((error as NodeJS.ErrnoException & { code?: unknown }).code as number | undefined) ?? 1)
          : 0;
        res({ code: typeof code === "number" ? code : 1, stdout, stderr });
      },
    );
  });
}

/** Throws unless localPath is a git repo whose origin points at repo on this code host. */
export async function validateRepoOrigin(
  localPath: string,
  repo: RepoRef,
  host: Pick<CodeHost, "parseOrigin">,
  baseUrl?: string,
): Promise<void> {
  const info = await stat(localPath).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`not a directory: ${localPath}`);
  const r = await run("git", ["-C", localPath, "remote", "get-url", "origin"]);
  if (r.code !== 0) {
    throw new Error(`not a git repository with an origin remote: ${r.stderr.trim() || localPath}`);
  }
  const origin = host.parseOrigin(r.stdout.trim(), baseUrl);
  if (
    !origin ||
    origin.owner.toLowerCase() !== repo.owner.toLowerCase() ||
    origin.name.toLowerCase() !== repo.name.toLowerCase()
  ) {
    throw new Error(
      `origin remote "${r.stdout.trim()}" does not match ${repo.owner}/${repo.name}`,
    );
  }
}

/**
 * Runs fn with a throwaway GIT_ASKPASS script environment: the credentials ride
 * env vars of the child process only, never argv, never .git/config, and
 * the script dies in finally. Shared by clone (here) and fetch (#9).
 * The username convention is per code host — callers get it from pushCredentials().
 */
export async function withAskpass<T>(
  credentials: PushCredentials,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const askDir = await mkdtemp(join(tmpdir(), "nb-askpass-"));
  const isWin = process.platform === "win32";
  const script = join(askDir, isWin ? "askpass.bat" : "askpass.sh");
  const body = isWin
    ? '@echo off\r\necho %~1| findstr /b /c:"Username" >nul\r\nif errorlevel 1 (echo %NB_GIT_TOKEN%) else (echo %NB_GIT_USERNAME%)\r\n'
    : '#!/bin/sh\ncase "$1" in\n  Username*) printf %s "$NB_GIT_USERNAME" ;;\n  *) printf %s "$NB_GIT_TOKEN" ;;\nesac\n';
  await writeFile(script, body, { mode: 0o700 });
  try {
    return await fn({
      ...process.env,
      GIT_ASKPASS: script,
      NB_GIT_USERNAME: credentials.username,
      NB_GIT_TOKEN: credentials.password,
    });
  } finally {
    await rm(askDir, { recursive: true, force: true });
  }
}

/**
 * Full clone (no shallow — worktrees need history, #9) authenticated via
 * withAskpass. The plain https URL means nothing needs scrubbing afterwards.
 */
export async function cloneRepo(
  host: Pick<CodeHost, "cloneUrl" | "parseOrigin">,
  repo: RepoRef,
  destParent: string,
  credentials: PushCredentials,
  baseUrl?: string,
): Promise<string> {
  const dest = join(destParent, repo.name);
  if (await stat(dest).catch(() => null)) {
    throw new Error(`destination already exists: ${dest}`);
  }
  await mkdir(destParent, { recursive: true });

  const r = await withAskpass(credentials, (env) =>
    run("git", ["clone", host.cloneUrl(repo, baseUrl), dest], {
      env,
      timeout: 600_000,
    }),
  );
  if (r.code !== 0) {
    await rm(dest, { recursive: true, force: true });
    throw new Error(`git clone failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  await validateRepoOrigin(dest, repo, host, baseUrl);
  return dest;
}

/**
 * Parse `git ls-remote --symref <url> HEAD refs/heads/*` output. Exported for tests.
 * The `ref: refs/heads/<b>\tHEAD` symref line gives the default branch; the
 * `<sha>\trefs/heads/<b>` lines give the branches. Without a symref line, a
 * unique sha match against the `<sha>\tHEAD` line recovers the default; an
 * ambiguous match leaves it undefined.
 */
export function parseLsRemoteHeads(stdout: string): {
  branches: string[];
  defaultBranch?: string;
} {
  const branches = new Set<string>();
  const shaByBranch = new Map<string, string>();
  let defaultBranch: string | undefined;
  let headSha: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(trimmed);
    if (symref) {
      defaultBranch = symref[1];
      continue;
    }
    const [left, right] = trimmed.split("\t");
    if (!right) continue;
    if (right === "HEAD") {
      headSha = left;
      continue;
    }
    const head = /^refs\/heads\/(.+)$/.exec(right);
    if (head) {
      branches.add(head[1]);
      shaByBranch.set(head[1], left);
    }
  }
  if (!defaultBranch && headSha) {
    const matches = [...shaByBranch.entries()].filter(([, sha]) => sha === headSha);
    if (matches.length === 1) defaultBranch = matches[0][0];
  }
  return { branches: [...branches].sort(), defaultBranch };
}

/**
 * Branch names + default branch of a remote, without a local clone (#156):
 * `git ls-remote --symref <cloneUrl> HEAD refs/heads/*` under GIT_ASKPASS. The
 * two refspecs keep GitHub's refs/pull/* namespace out.
 */
export async function listRemoteHeads(
  host: Pick<CodeHost, "cloneUrl">,
  repo: RepoRef,
  credentials: PushCredentials,
  baseUrl?: string,
): Promise<{ branches: string[]; defaultBranch?: string }> {
  const url = host.cloneUrl(repo, baseUrl);
  const r = await withAskpass(credentials, (env) =>
    run("git", ["ls-remote", "--symref", url, "HEAD", "refs/heads/*"], { env, timeout: 60_000 }),
  );
  if (r.code !== 0) {
    throw new Error(`git ls-remote failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
  return parseLsRemoteHeads(r.stdout);
}
