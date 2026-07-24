import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import type { IpcMain } from "electron";
import type { GitOpResult, GitStatus } from "@skipper/shared";

// Public git engine (issue #1 — open-core boundary redraw).
//
// The git loop is product core, so these handlers live in the public tree.
// They shell out to the user's `git` binary: auth (push/pull) rides on the
// machine's credential helpers / SSH keys — we never see or store secrets.
// The IPC contract mirrors apps/desktop/src/preload.ts `git:` verbatim.

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(
  cwd: string,
  args: string[],
  timeout = 60_000,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((res) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        // Never let git block the main process on an interactive prompt —
        // fail fast and surface stderr to the renderer instead.
        env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException & { code?: unknown }).code as number | undefined) ?? 1 : 0;
        res({ code: typeof code === "number" ? code : 1, stdout, stderr });
      },
    );
  });
}

function toOp(r: RunResult): GitOpResult {
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
}

// git prints forward-slash paths even on Windows; normalize() makes them
// comparable with the join()-built paths the renderer works with.
function samePath(a: string, b: string): boolean {
  const na = resolve(normalize(a));
  const nb = resolve(normalize(b));
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function parsePorcelainV2(out: string): GitStatus {
  const status: GitStatus = {
    branch: "",
    ahead: 0,
    behind: 0,
    files: {},
    hasUpstream: false,
  };
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith("# branch.head ")) {
      status.branch = t.slice("# branch.head ".length);
    } else if (t.startsWith("# branch.upstream ")) {
      status.hasUpstream = true;
    } else if (t.startsWith("# branch.ab ")) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(t);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (t.startsWith("1 ")) {
      const parts = t.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(8).join(" ");
      status.files[path] = { index: dot(xy[0]), worktree: dot(xy[1]) };
    } else if (t.startsWith("2 ")) {
      const parts = t.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(9).join(" ");
      status.files[path] = { index: dot(xy[0]), worktree: dot(xy[1]) };
      i++; // in -z mode the rename's original path is the next token — skip it
    } else if (t.startsWith("u ")) {
      const parts = t.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(10).join(" ");
      status.files[path] = { index: dot(xy[0]), worktree: dot(xy[1]) };
    } else if (t.startsWith("? ")) {
      status.files[t.slice(2)] = { index: "?", worktree: "?" };
    } else if (t.startsWith("! ")) {
      status.files[t.slice(2)] = { index: "!", worktree: "!" };
    }
  }
  return status;
}

function dot(c: string | undefined): string {
  return !c || c === "." ? " " : c;
}

async function repoTop(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const r = await runGit(dir, ["rev-parse", "--show-toplevel"], 15_000);
  if (r.code !== 0) return null;
  const top = r.stdout.trim();
  return top ? normalize(top) : null;
}

async function readStatus(repoPath: string): Promise<GitStatus | null> {
  const r = await runGit(repoPath, ["status", "--porcelain=v2", "--branch", "-z"], 15_000);
  if (r.code !== 0) return null;
  return parsePorcelainV2(r.stdout);
}

export function registerGitHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("skipper:git:status", async (_e, repoPath: string): Promise<GitStatus | null> => {
    const top = await repoTop(repoPath);
    if (!top || !samePath(top, repoPath)) return null;
    return readStatus(repoPath);
  });

  ipcMain.handle(
    "skipper:git:findRepo",
    async (_e, anyPath: string): Promise<{ repoPath: string; status: GitStatus } | null> => {
      if (!existsSync(anyPath)) return null;
      const dir = statSync(anyPath).isDirectory() ? anyPath : dirname(anyPath);
      const top = await repoTop(dir);
      if (!top) return null;
      const status = await readStatus(top);
      return status ? { repoPath: top, status } : null;
    },
  );

  ipcMain.handle("skipper:git:stage", async (_e, repoPath: string, paths: string[]) =>
    toOp(await runGit(repoPath, ["add", "--", ...paths])),
  );

  ipcMain.handle("skipper:git:unstage", async (_e, repoPath: string, paths: string[]) => {
    const r = await runGit(repoPath, ["reset", "-q", "--", ...paths]);
    // Unborn branch (no commit yet): reset can't resolve HEAD — drop the
    // paths from the index instead.
    if (r.code !== 0 && /HEAD/.test(r.stderr)) {
      return toOp(await runGit(repoPath, ["rm", "-r", "-q", "--cached", "--", ...paths]));
    }
    return toOp(r);
  });

  ipcMain.handle("skipper:git:discard", async (_e, repoPath: string, paths: string[]) => {
    // Untracked files are deleted, tracked ones restored from the index.
    // checkout legitimately fails when every path was untracked — clean
    // already handled those.
    const clean = await runGit(repoPath, ["clean", "-qfd", "--", ...paths]);
    const checkout = await runGit(repoPath, ["checkout", "-q", "--", ...paths]);
    const ok = clean.code === 0 && (checkout.code === 0 || /did not match any file/.test(checkout.stderr));
    return {
      ok,
      stdout: clean.stdout + checkout.stdout,
      stderr: ok ? "" : clean.stderr + checkout.stderr,
    };
  });

  ipcMain.handle("skipper:git:commit", async (_e, repoPath: string, message: string) =>
    toOp(await runGit(repoPath, ["commit", "-m", message])),
  );

  ipcMain.handle("skipper:git:push", async (_e, repoPath: string) => {
    const r = await runGit(repoPath, ["push"], 120_000);
    if (r.code !== 0 && /no upstream|set-upstream/i.test(r.stderr)) {
      return toOp(await runGit(repoPath, ["push", "-u", "origin", "HEAD"], 120_000));
    }
    return toOp(r);
  });

  ipcMain.handle("skipper:git:pull", async (_e, repoPath: string) =>
    toOp(await runGit(repoPath, ["pull", "--no-edit"], 120_000)),
  );

  ipcMain.handle("skipper:git:stashList", async (_e, repoPath: string) => {
    const r = await runGit(repoPath, ["stash", "list", "--format=%gd%x09%gs"]);
    const stashes = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return tab === -1
          ? { ref: line, message: "" }
          : { ref: line.slice(0, tab), message: line.slice(tab + 1) };
      });
    return { ...toOp(r), stashes };
  });

  ipcMain.handle(
    "skipper:git:stashPush",
    async (_e, repoPath: string, message?: string, includeUntracked?: boolean) => {
      const args = ["stash", "push"];
      if (includeUntracked) args.push("-u");
      if (message) args.push("-m", message);
      return toOp(await runGit(repoPath, args));
    },
  );

  ipcMain.handle("skipper:git:stashPop", async (_e, repoPath: string, ref?: string) =>
    toOp(await runGit(repoPath, ref ? ["stash", "pop", ref] : ["stash", "pop"])),
  );

  ipcMain.handle("skipper:git:stashDrop", async (_e, repoPath: string, ref: string) =>
    toOp(await runGit(repoPath, ["stash", "drop", ref])),
  );
}
