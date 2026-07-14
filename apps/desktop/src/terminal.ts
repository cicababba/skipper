import type { BrowserWindow, IpcMain } from "electron";

// Public terminal engine (issue #18 — follows the boundary set in #1).
//
// The integrated terminal is product core: it's the live window on the
// coding agent and the escape hatch for manual work in a worktree. The IPC
// contract mirrors apps/desktop/src/preload.ts `terminal:` verbatim.

interface PtyProcess {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

interface PtyModule {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      name: string;
      cwd: string;
      cols: number;
      rows: number;
      env: NodeJS.ProcessEnv;
      useConpty?: boolean;
    },
  ) => PtyProcess;
}

// node-pty is a native binding: a load failure (bad ABI, missing binary on
// an exotic platform) must degrade to "no terminal", never crash the app.
function loadPty(): PtyModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node-pty") as PtyModule;
  } catch {
    return null;
  }
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

export interface TerminalDeps {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
}

export interface TerminalApi {
  killAllPtySessions: () => void;
}

export function registerTerminalHandlers(deps: TerminalDeps): TerminalApi {
  const { ipcMain, getMainWindow } = deps;
  const sessions = new Map<string, PtyProcess>();
  let nextId = 1;

  // Overlaid builds may still ship the Dev module's terminal backend, which
  // registers these channels first — it wins per-channel until the private
  // repo drops it (same transition dance as registerGitHandlers).
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    try {
      ipcMain.handle(channel, fn as Parameters<IpcMain["handle"]>[1]);
    } catch {
      /* overlay already owns this channel */
    }
  };
  const on = (channel: string, fn: (...args: never[]) => void): void => {
    if (ipcMain.listenerCount(channel) > 0) return;
    ipcMain.on(channel, fn as Parameters<IpcMain["on"]>[1]);
  };

  handle(
    "skipper:terminal:create",
    (_e, opts: { cwd: string; cols?: number; rows?: number }): { id: string; cwd: string } => {
      const pty = loadPty();
      if (!pty) throw new Error("terminal unavailable: node-pty failed to load");

      const id = String(nextId++);
      const proc = pty.spawn(defaultShell(), [], {
        name: "xterm-256color",
        cwd: opts.cwd,
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        env: process.env,
      });
      sessions.set(id, proc);

      proc.onData((data) => {
        getMainWindow()?.webContents.send(`skipper:terminal:data:${id}`, data);
      });
      proc.onExit(({ exitCode }) => {
        sessions.delete(id);
        getMainWindow()?.webContents.send(`skipper:terminal:exit:${id}`, exitCode);
      });

      return { id, cwd: opts.cwd };
    },
  );

  on("skipper:terminal:write", (_e, msg: { id: string; data: string }) => {
    sessions.get(msg.id)?.write(msg.data);
  });

  on("skipper:terminal:resize", (_e, msg: { id: string; cols: number; rows: number }) => {
    if (msg.cols > 0 && msg.rows > 0) sessions.get(msg.id)?.resize(msg.cols, msg.rows);
  });

  on("skipper:terminal:kill", (_e, msg: { id: string }) => {
    sessions.get(msg.id)?.kill();
    sessions.delete(msg.id);
  });

  return {
    // Live pty children keep the process alive past app.quit() — the
    // teardown paths in main.ts call this to avoid the zombie-app bug.
    killAllPtySessions: () => {
      for (const proc of sessions.values()) {
        try {
          proc.kill();
        } catch {
          /* already dead */
        }
      }
      sessions.clear();
    },
  };
}
