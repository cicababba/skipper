import {
  app,
  BrowserWindow,
  shell,
  Menu,
  ipcMain,
  dialog,
  protocol,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
} from "electron";
import { join, dirname, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  renameSync,
  rmSync,
} from "node:fs";
import { execSync, spawn } from "node:child_process";
import { AuthManager } from "./auth";
import { providerMetadata } from "./auth/providers";
import {
  AUTH_PROVIDER_IDS,
  type AuthProviderId,
  type AuthProviderMeta,
  type AuthState,
  type CliStatus,
  type FsEntry,
} from "@skipper/shared";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { registerGitHandlers } from "./git";
import { registerTerminalHandlers, type TerminalApi } from "./terminal";
import { registerExportHandlers } from "./export-ipc";
import { registerSettingsHandlers } from "./settings-ipc";
import { registerAppProtocol } from "./app-protocol";
import { assertInsideWorktrees as assertInsideWorktreesRoot, looksBinary } from "./fs-guard";

// Set once the lazy updater bundle loads; lets auth changes refresh the
// update credentials + "via" label immediately.
let updaterRecheck: (() => void) | null = null;
let orchestratorPoke: (() => void) | null = null;
let coderKillAll: (() => void) | null = null;
let plannerKillAll: (() => void) | null = null;
let rescoreKillAll: (() => void) | null = null;

// On macOS, packaged Electron apps don't inherit the user's shell PATH —
// they get a minimal PATH like /usr/bin:/bin which doesn't include common
// install locations (~/.npm-global/bin, /opt/homebrew/bin, etc.). This
// breaks spawning external CLIs like `claude` (the Anthropic Claude CLI)
// from the LLM provider.
//
// Inline replacement for the `fix-path` package (which is ESM-only in v4
// and can't be `require()`'d from our CJS main bundle): spawn the user's
// default shell as an interactive login shell, ask it for PATH, then
// override the current process env. Falls back to a list of common bin
// dirs if shell invocation fails.
function fixMacPath(): void {
  if (process.platform !== "darwin") return;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execSync(`"${shell}" -ilc 'echo "$PATH"'`, {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (out && out.length > 0) {
      process.env.PATH = out;
      return;
    }
  } catch {
    /* fall through to default extension */
  }
  const home = process.env.HOME || "";
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    `${home}/.npm-global/bin`,
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    "/usr/local/sbin",
  ];
  process.env.PATH = `${extra.join(":")}:${process.env.PATH || ""}`;
}
fixMacPath();

// Windows counterpart. A running process keeps the PATH it started with, but a
// fresh CLI install (npm global, or the native `claude.ai/install.cmd` → it
// drops claude.exe in %USERPROFILE%\.local\bin and updates the *registry* PATH)
// only reaches NEW processes — so restarting the app often still can't find
// `claude`. Read the live user + system PATH from the registry and merge it in,
// plus the well-known install dirs, so spawns see the current PATH without a
// reboot.
function expandWinEnv(s: string): string {
  return s.replace(/%([^%]+)%/g, (_m, name) => process.env[name] ?? `%${name}%`);
}
function fixWinPath(): void {
  if (process.platform !== "win32") return;
  const merged = new Set((process.env.PATH || "").split(";").filter(Boolean));
  for (const q of [
    'reg query "HKCU\\Environment" /v Path',
    'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
  ]) {
    try {
      const out = execSync(q, { encoding: "utf8", timeout: 3000, windowsHide: true });
      const m = out.match(/\bPath\s+REG(?:_EXPAND)?_SZ\s+(.+)/i);
      if (m) expandWinEnv(m[1].trim()).split(";").map((p) => p.trim()).filter(Boolean).forEach((p) => merged.add(p));
    } catch {
      /* registry not readable — the well-known dirs below still cover the common case */
    }
  }
  const home = process.env.USERPROFILE || "";
  const appdata = process.env.APPDATA || "";
  const local = process.env.LOCALAPPDATA || "";
  for (const d of [
    home && join(home, ".local", "bin"), // native installer (claude.ai/install.cmd)
    appdata && join(appdata, "npm"), // npm -g
    local && join(local, "Programs", "claude"), // some native-install layouts
  ]) {
    if (d) merged.add(d);
  }
  process.env.PATH = Array.from(merged).join(";");
}
fixWinPath();

const isDev = !!process.env.SKIPPER_DEV;
// Overridable for when :3000 is taken by something else on the dev machine.
const DEV_URL = process.env.SKIPPER_DEV_URL || "http://localhost:3000";
/** Dev-only retry gap while waiting for the Next dev server to bind its port. */
const DEV_RELOAD_DELAY_MS = 500;

// Must be set before app is ready so the menu bar shows "Skipper" not "Electron"
app.setName("Skipper");

// The static-export web UI is served over app://skipper (#208). The scheme must
// be registered as privileged before app ready so the app-router client nav
// (RSC fetches, Link prefetch) and code caching work like a normal https origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

// Dev-only: Linux boxes without a Secret Service (e.g. WSL) have no
// safeStorage backend, so token persistence is refused and every restart
// logs the account out. The "basic" store is weak obfuscation — acceptable
// for dev credentials, never enabled in packaged builds.
if (isDev && process.platform === "linux") {
  app.commandLine.appendSwitch("password-store", "basic");
}

// Black-window-after-unfocus fix, part 1 (must run before app is ready).
// When the window is occluded/unfocused for a while, Chromium backgrounds the
// renderer and (on macOS) tears down the compositor surface via its occlusion
// tracker; a known macOS bug leaves the surface black on return. webPreferences
// backgroundThrottling:false only covers JS timers — these switches stop the
// process-level backgrounding and the occlusion teardown itself.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-features", "MacWebContentsOcclusion");
}

let mainWindow: BrowserWindow | null = null;

// Hard single-instance guarantee: whatever launches the binary again (CLI
// wrappers, git hooks, OS file associations, a double-click), the second
// process exits immediately and the existing window comes to front. Skipper
// must never run twice against the same workspace.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
let authManager: AuthManager | null = null;

function getDataDir(): string {
  const dir = app.getPath("userData");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getLlmSettingsDir(): string {
  // Dev loads the Next dev server (localhost:3000), whose settings.json fallback
  // is <repo>/data — read the same file or the UI and the roles disagree on the model.
  return isDev ? join(__dirname, "..", "..", "..", "data") : getDataDir();
}

/** Static-export web root: packaged resources in production, the local
 *  `apps/web/out` build in an unpackaged non-dev run (#208). */
function getWebRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "web")
    : join(__dirname, "../../web/out");
}

let shuttingDown = false;

/**
 * Black-window recovery, part 2. After the window was backgrounded/occluded,
 * the page can be alive-but-black (lost compositor surface) or silently hung.
 * Ping the renderer with a trivial script: responds → just repaint
 * (invalidate); times out or throws → reload in place. Cheap (runs only on
 * focus/show/restore/resume), and reload only fires when the page is truly
 * gone, so users never lose a healthy session.
 */
async function ensureRendererAlive(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || shuttingDown) return;
  const wc = mainWindow.webContents;
  if (wc.isCrashed()) {
    wc.reload();
    return;
  }
  try {
    await Promise.race([
      wc.executeJavaScript("1", true),
      new Promise((_, reject) => setTimeout(() => reject(new Error("renderer ping timeout")), 3000)),
    ]);
    wc.invalidate();
  } catch {
    console.warn("[renderer] not responding after wake — reloading");
    if (!shuttingDown) wc.reload();
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0a0a0a",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.js"),
      // Don't pause/throttle the renderer when the window loses focus or is
      // occluded — that throttling (combined with a GPU compositor hiccup) is
      // what left the window black-on-return until a manual restart.
      backgroundThrottling: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Windows/Linux run without an application menu, so no devtools
  // accelerator exists — wire one up in dev builds.
  if (isDev) {
    mainWindow.webContents.on("before-input-event", (_e, input) => {
      const ctrlShiftI = input.control && input.shift && input.key.toLowerCase() === "i";
      if (input.type === "keyDown" && (input.key === "F12" || ctrlShiftI)) {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  }

  // Auto-recover instead of leaving a black window the user must force-restart:
  // a renderer crash / OOM, or an unresponsive page, reloads in place.
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[renderer] process gone:", details.reason);
    if (details.reason !== "clean-exit" && !shuttingDown) mainWindow?.reload();
  });
  mainWindow.webContents.on("unresponsive", () => {
    console.warn("[renderer] unresponsive — reloading");
    if (!shuttingDown) mainWindow?.reload();
  });
  // macOS: the red close button quits the app entirely (after confirming)
  // instead of leaving a windowless process in the dock — reopening from the
  // dock could come back as a black window. Cmd+Q and the updater's restart
  // set shuttingDown first, so they pass through without the prompt.
  if (process.platform === "darwin") {
    mainWindow.on("close", (e) => {
      if (shuttingDown) return;
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: "question",
        buttons: ["Quit Skipper", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: "Quit Skipper?",
        detail: "This closes the app completely.",
      });
      if (choice === 0) {
        shuttingDown = true;
        app.quit();
      }
    });
  }

  // When the window comes back (focus / un-minimize / show), verify the
  // renderer actually responds; a black window with a live-looking process is
  // exactly the state invalidate() alone couldn't fix.
  mainWindow.on("focus", () => void ensureRendererAlive());
  mainWindow.on("restore", () => void ensureRendererAlive());
  mainWindow.on("show", () => void ensureRendererAlive());

  const url = isDev ? DEV_URL : "app://skipper/inbox";
  if (!isDev) {
    mainWindow.loadURL(url);
    return;
  }
  // Dev only: `pnpm dev` starts the Next dev server and Electron in parallel
  // (turbo runs both `dev` tasks at once), so this loadURL often lands before
  // the server binds the port. The packaged path can't hit this — app:// is
  // served synchronously — and a failed load never retries on its own, leaving
  // a black window forever. Retry until the server answers.
  const loadDev = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadURL(url).catch(() => {
      /* did-fail-load re-arms the retry */
    });
  };
  mainWindow.webContents.on("did-fail-load", (_e, _code, _desc, _failedUrl, isMainFrame) => {
    if (!isMainFrame || !mainWindow || mainWindow.isDestroyed()) return;
    setTimeout(loadDev, DEV_RELOAD_DELAY_MS);
  });
  loadDev();
}

function setupMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        {
          label: "About Skipper",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show();
              mainWindow.webContents.send("skipper:show-about");
            }
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// === IPC handlers ===
ipcMain.handle("skipper:openExternal", (_e, url: string) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) void shell.openExternal(url);
});

ipcMain.handle("skipper:getBootstrap", () => {
  return {
    isElectron: true,
    platform: process.platform,
  };
});

ipcMain.handle("skipper:selectDirectory", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Select",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

registerGitHandlers(ipcMain);
const publicTerminal: TerminalApi = registerTerminalHandlers({
  ipcMain,
  getMainWindow: () => mainWindow,
});

registerExportHandlers({
  ipcMain,
  getMainWindow: () => mainWindow,
  showSaveDialog: (w, o) => dialog.showSaveDialog(w, o),
  writeFile: (p, c) => writeFileAsync(p, c, "utf8"),
});

registerSettingsHandlers({ ipcMain, settingsDir: getLlmSettingsDir });

function killAllPtySessions(): void {
  publicTerminal.killAllPtySessions();
}

// === Directory listing (for file tree) ===
function isHiddenOrIgnored(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "node_modules" ||
    name === ".skipper"
  );
}

ipcMain.handle(
  "skipper:fs:list",
  (_e, dirPath: string): FsEntry[] => {
    if (!existsSync(dirPath)) return [];
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => !isHiddenOrIgnored(e.name))
        .map((e) => ({
          name: e.name,
          path: join(dirPath, e.name),
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return [];
    }
  },
);

ipcMain.handle(
  "skipper:fs:createDir",
  (_e, dirPath: string): { ok: true; path: string } => {
    const abs = assertInsideWorktrees(dirPath);
    mkdirSync(abs, { recursive: true });
    return { ok: true, path: abs };
  },
);

// ===== File read/write for the in-app editor =====
// Sandbox boundary (intentional): skipper:fs:list above enumerates any
// directory, because the repo file-tree legitimately browses checkouts that
// live outside the worktrees root. Everything that reads file *contents* or
// mutates the disk (readFile/writeFile/createDir/delete/rename) is locked to
// the worktrees root via assertInsideWorktrees — so a compromised preload can
// list paths but cannot read or write arbitrary files elsewhere.
const MAX_EDITABLE_BYTES = 1024 * 1024; // 1 MiB hard cap for the editor

interface ReadFileResult {
  content: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
}

function worktreesRoot(): string {
  return resolve(join(app.getPath("userData"), "worktrees"));
}

function assertInsideWorktrees(targetPath: string): string {
  return assertInsideWorktreesRoot(targetPath, worktreesRoot());
}

ipcMain.handle(
  "skipper:fs:readFile",
  (_e, filePath: string): ReadFileResult => {
    const abs = assertInsideWorktrees(filePath);
    const stat = statSync(abs);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${abs}`);
    }
    if (stat.size > MAX_EDITABLE_BYTES) {
      return { content: "", size: stat.size, binary: false, tooLarge: true };
    }
    const buf = readFileSync(abs);
    if (looksBinary(buf)) {
      return { content: "", size: stat.size, binary: true, tooLarge: false };
    }
    return {
      content: buf.toString("utf-8"),
      size: stat.size,
      binary: false,
      tooLarge: false,
    };
  },
);

ipcMain.handle(
  "skipper:fs:writeFile",
  (_e, filePath: string, content: string): { ok: true; size: number } => {
    const abs = assertInsideWorktrees(filePath);
    // Ensure parent directory exists
    const parent = join(abs, "..");
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(abs, content, "utf-8");
    return { ok: true, size: Buffer.byteLength(content, "utf-8") };
  },
);

ipcMain.handle(
  "skipper:fs:delete",
  (_e, targetPath: string): { ok: true } => {
    const abs = assertInsideWorktrees(targetPath);
    if (abs === worktreesRoot()) {
      throw new Error("The worktrees root cannot be deleted.");
    }
    if (!existsSync(abs)) {
      throw new Error("Path does not exist");
    }
    rmSync(abs, { recursive: true, force: true });
    return { ok: true };
  },
);

ipcMain.handle(
  "skipper:fs:rename",
  (
    _e,
    oldPath: string,
    newName: string,
  ): { ok: true; newPath: string } => {
    const absOld = assertInsideWorktrees(oldPath);
    if (absOld === worktreesRoot()) {
      throw new Error("The worktrees root cannot be renamed.");
    }
    const trimmed = (newName ?? "").trim();
    if (
      !trimmed ||
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      trimmed === "." ||
      trimmed === ".."
    ) {
      throw new Error("Invalid name");
    }
    const parent = join(absOld, "..");
    const absNew = join(parent, trimmed);
    // Must still end up inside the worktrees root (extra safety)
    assertInsideWorktrees(absNew);
    if (existsSync(absNew)) {
      throw new Error(`A file or folder named "${trimmed}" already exists`);
    }
    renameSync(absOld, absNew);
    return { ok: true, newPath: absNew };
  },
);

// ===== Session handoff: run the bundled `skipper session` CLI, capture output =====
ipcMain.handle(
  "skipper:session:run",
  (_e, mode: "save" | "resume", projectDir: string): Promise<{ ok: boolean; output: string }> => {
    if (mode !== "save" && mode !== "resume") throw new Error("invalid mode");
    const abs = assertInsideWorktrees(projectDir);
    return new Promise((resolveP) => {
      let onPath = false;
      try {
        execSync(process.platform === "win32" ? "where skipper" : "command -v skipper", { stdio: "ignore" });
        onPath = true;
      } catch { /* not on PATH → use bundled wrapper */ }
      const cmd = onPath ? "skipper" : cliWrapperSource();
      const proc = spawn(cmd, ["session", mode, "-p", abs], { shell: process.platform === "win32", env: process.env });
      let out = "", err = "";
      proc.stdout.on("data", (d) => (out += d.toString()));
      proc.stderr.on("data", (d) => (err += d.toString()));
      proc.on("error", (e) => resolveP({ ok: false, output: String(e) }));
      proc.on("close", (code) =>
        resolveP({ ok: code === 0, output: (out || err).trim() || (code === 0 ? "Done." : `exited ${code}`) }),
      );
    });
  },
);

// === Auth (multi-provider OAuth) ===
ipcMain.handle("skipper:auth:getState", (): AuthState => {
  return authManager?.getState() ?? { accounts: [], flows: {} };
});

ipcMain.handle("skipper:auth:getProviders", (): AuthProviderMeta[] => {
  // The issue-source registry lives in the ESM @skipper/core — reach it via
  // the orchestrator bundle; a broken bundle must never block auth, so
  // degrade to identity-only (repo-picker affordances hide).
  let isIssueSource = (_: AuthProviderId) => false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    isIssueSource = (require("./orchestrator.cjs") as typeof import("./orchestrator"))
      .isIssueSourceProvider;
  } catch {
    /* fall back to identity-only */
  }
  return providerMetadata(isIssueSource);
});

for (const provider of AUTH_PROVIDER_IDS) {
  ipcMain.handle(`skipper:auth:${provider}:signIn`, async (_e, options?: { baseUrl?: string; clientId?: string }) => {
    if (!authManager) throw new Error("Auth not initialized");
    await authManager.signIn(provider, options);
  });

  ipcMain.handle(
    `skipper:auth:${provider}:signInWithPat`,
    async (_e, pat: string, options?: { baseUrl?: string }) => {
      if (!authManager) throw new Error("Auth not initialized");
      await authManager.signInWithPat(provider, pat, options);
    },
  );

  ipcMain.handle(`skipper:auth:${provider}:signOut`, async (_e, accountId?: string) => {
    if (!authManager) throw new Error("Auth not initialized");
    if (!accountId) return; // stale renderer — sign-out is always per-account now
    // accountId is the account key (Account.key); the provider comes from the store.
    await authManager.signOut(accountId);
  });

  ipcMain.handle(`skipper:auth:${provider}:cancelSignIn`, () => {
    authManager?.cancelSignIn(provider);
  });

  ipcMain.handle(`skipper:auth:${provider}:chooseResource`, (_e, resourceId: string) => {
    authManager?.chooseResource(provider, resourceId);
  });
}

// ====== CLI on PATH (macOS / Windows) ======

/**
 * Where the user's PATH-installed `skipper` symlink/wrapper lives.
 * - macOS: /usr/local/bin/skipper (matches Homebrew's bin and VS Code's
 *   `code` command convention). Requires sudo to write.
 * - Windows: %LOCALAPPDATA%/Skipper/cli/skipper.bat — user-scoped so
 *   no admin prompt is needed; the install also appends that dir to the
 *   user-level PATH via setx.
 */
function cliInstallTarget(): string | null {
  if (process.platform === "darwin") return "/usr/local/bin/skipper";
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) return null;
    return join(local, "Skipper", "cli", "skipper.bat");
  }
  return null;
}

/**
 * Absolute path of the CLI wrapper shipped with the running app.
 * In packaged mode: <App>/Contents/Resources/cli/skipper (macOS) or
 * <install-dir>/resources/cli/skipper.bat (Windows). In dev we point at
 * the source dir so install-on-PATH can be tested without packaging.
 */
function cliWrapperSource(): string {
  const wrapperName = process.platform === "win32" ? "skipper.bat" : "skipper";
  if (app.isPackaged) {
    return join(process.resourcesPath, "cli", wrapperName);
  }
  return join(__dirname, "../../desktop/build/cli", wrapperName);
}

/**
 * Absolute path of the CLI JS bundle shipped with the running app, or null when
 * it isn't present (dev before `pnpm --filter @skipper/cli build`). The
 * orchestrator hands this to planner/coder runs so they can spawn the
 * skipper-memory MCP server (#45). Packaged, the bundle lives in
 * resources/cli-runtime next to its externalized node_modules
 * (@huggingface/transformers, onnx) — the embedder host that survived the
 * standalone tree's removal (#208).
 */
function cliBundlePath(): string | null {
  const bundle = app.isPackaged
    ? join(process.resourcesPath, "cli-runtime", "skipper.bundle.cjs")
    : join(__dirname, "../../../packages/cli/dist/skipper.bundle.cjs");
  return existsSync(bundle) ? bundle : null;
}

async function getCliStatus(): Promise<CliStatus> {
  const target = cliInstallTarget();
  const source = cliWrapperSource();
  if (!target) return { supported: false, target: null, source, installed: false, stale: false };

  const { readlink, stat: statAsync } = await import("node:fs/promises");
  if (!existsSync(target)) return { supported: true, target, source, installed: false, stale: false };

  if (process.platform === "darwin") {
    try {
      const link = await readlink(target);
      // Normalize: readlink may return a relative path; resolve against the
      // link's directory.
      const resolved = link.startsWith("/") ? link : resolve(join(target, ".."), link);
      // "Stale" must mean the symlink is BROKEN (points at a path that no
      // longer exists — e.g. the app was moved or deleted). It must NOT mean
      // "points at a different valid wrapper than this exact build": the
      // packaged app, a dev build, and a translocated copy all resolve to
      // different but equally-working sources, and comparing against the
      // current build's path flagged a perfectly good install as stale on
      // every relaunch, forcing a needless re-install.
      const dangling = !existsSync(resolved);
      return { supported: true, target, source, installed: true, stale: dangling };
    } catch {
      // Not a symlink (regular file or dir). It exists (checked above) so the
      // command is present; we simply don't manage it. Don't nag as stale.
      return { supported: true, target, source, installed: true, stale: false };
    }
  }
  // Windows: file or shortcut. We just check it exists; staleness check
  // is best-effort via comparing wrapper contents.
  try {
    const stats = await statAsync(target);
    return { supported: true, target, source, installed: stats.isFile(), stale: false };
  } catch {
    return { supported: true, target, source, installed: false, stale: false };
  }
}

ipcMain.handle("skipper:cli:status", async () => getCliStatus());

ipcMain.handle("skipper:cli:install", async () => {
  const status = await getCliStatus();
  if (!status.supported || !status.target) {
    throw new Error("CLI install not supported on this platform.");
  }
  if (process.platform === "darwin") {
    // A small launcher SCRIPT, not a symlink: a symlink hard-binds to the
    // wrapper path of the build that installed it (a dev tree that later gets
    // cleaned, an app that gets moved) and dies with it. The launcher tries
    // the installing build first, then the standard app locations — so it
    // keeps working across updates, dev/packaged switches and app moves.
    const launcher = [
      "#!/bin/sh",
      "# Skipper CLI launcher (managed by Skipper — Settings → Command line)",
      "for w in \\",
      `  "${status.source}" \\`,
      '  "/Applications/Skipper.app/Contents/Resources/cli/skipper" \\',
      '  "$HOME/Applications/Skipper.app/Contents/Resources/cli/skipper"',
      "do",
      '  [ -x "$w" ] && exec "$w" "$@"',
      "done",
      'echo "skipper: Skipper.app not found. Re-install the CLI from Skipper → Settings → Command line." >&2',
      "exit 127",
      "",
    ].join("\n");
    const tmpLauncher = join(app.getPath("temp"), "skipper-cli-launcher");
    writeFileSync(tmpLauncher, launcher, { mode: 0o755 });
    // /usr/local/bin needs sudo. osascript surfaces the native admin prompt.
    const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const cmd = `mkdir -p "$(dirname "${escape(status.target)}")" && install -m 0755 "${escape(tmpLauncher)}" "${escape(status.target)}"`;
    const apple = `do shell script "${escape(cmd)}" with administrator privileges`;
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("osascript", ["-e", apple]);
      let stderr = "";
      proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      proc.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `osascript exited with code ${code}`));
      });
      proc.on("error", reject);
    });
    return getCliStatus();
  }
  if (process.platform === "win32") {
    // User-scoped install into %LOCALAPPDATA%/Skipper/cli + user PATH.
    // Generate a launcher that CALLS the wrapper inside the install dir by
    // absolute path — copying the .bat broke it: its %~dp0-relative bundle
    // lookup resolved against the copy's location, where nothing exists.
    const targetDir = dirname(status.target);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const launcher = [
      "@echo off",
      "REM Skipper CLI launcher (managed by Skipper - Settings > Command line)",
      `if exist "${status.source}" (`,
      `  call "${status.source}" %*`,
      "  exit /b %errorlevel%",
      ")",
      "echo skipper: Skipper installation not found. Re-install the CLI from Settings ^> Command line. 1>&2",
      "exit /b 127",
      "",
    ].join("\r\n");
    writeFileSync(status.target, launcher, "utf-8");
    // Append to user PATH if missing.
    try {
      const userPath = execSync('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'User\')"', { encoding: "utf-8" }).trim();
      if (!userPath.split(";").map((s) => s.trim().toLowerCase()).includes(targetDir.toLowerCase())) {
        const next = userPath ? `${userPath};${targetDir}` : targetDir;
        execSync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path','${next.replace(/'/g, "''")}','User')"`);
      }
    } catch (err) {
      console.error("[cli:install] PATH update failed:", err);
    }
    return getCliStatus();
  }
  throw new Error("Unsupported platform");
});

ipcMain.handle("skipper:cli:uninstall", async () => {
  const status = await getCliStatus();
  if (!status.supported || !status.target || !status.installed) return getCliStatus();
  if (process.platform === "darwin") {
    const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const cmd = `rm -f "${escape(status.target)}"`;
    const apple = `do shell script "${escape(cmd)}" with administrator privileges`;
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("osascript", ["-e", apple]);
      let stderr = "";
      proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      proc.on("close", (code: number) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `osascript exited ${code}`))));
      proc.on("error", reject);
    });
    return getCliStatus();
  }
  if (process.platform === "win32") {
    try { rmSync(status.target, { force: true }); } catch { /* ignore */ }
    return getCliStatus();
  }
  throw new Error("Unsupported platform");
});

// --- Update entitlement (phase 2) -----------------------------------------
// Supporter ($29): the in-app Google sign-in proves the email; the licensing
// service confirms the Polar purchase and mints a 30-day signed entitlement we
// cache on disk.
const LICENSING_BASE = "https://license.skipper.app";
const ENTITLEMENT_FILE = () => join(app.getPath("userData"), "update-entitlement.json");

async function getSupporterEntitlement(): Promise<string | null> {
  try {
    const cached = JSON.parse(readFileSync(ENTITLEMENT_FILE(), "utf-8")) as { token?: string; exp?: number };
    // Reuse while >5 days of validity remain; refresh in the background after.
    if (cached.token && cached.exp && cached.exp * 1000 > Date.now() + 5 * 86400_000) {
      return cached.token;
    }
  } catch { /* no cache yet */ }

  const idToken = await authManager?.getGoogleIdToken();
  if (!idToken) return null;
  try {
    const res = await fetch(`${LICENSING_BASE}/entitlement/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) return null; // not a purchaser (or service down) — fine
    const d = (await res.json()) as { token: string; exp: number };
    writeFileSync(ENTITLEMENT_FILE(), JSON.stringify({ token: d.token, exp: d.exp }));
    return d.token;
  } catch {
    return null;
  }
}

async function getUpdateCredentials(): Promise<{ entitlement?: string | null }> {
  return { entitlement: await getSupporterEntitlement() };
}

app.whenReady().then(async () => {
  // Black-window fix, part 3: macOS App Nap suspends the whole process when
  // the app is hidden long enough — on wake the GPU surface is gone and the
  // window stays black. prevent_app_suspension blocks App Nap only (display
  // sleep is untouched). Also re-verify the renderer after system sleep.
  if (process.platform === "darwin") {
    powerSaveBlocker.start("prevent-app-suspension");
  }
  powerMonitor.on("resume", () => void ensureRendererAlive());

  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    try {
      const iconPath = join(__dirname, "../build/icon.png");
      if (existsSync(iconPath)) app.dock.setIcon(iconPath);
    } catch {
      /* ignore */
    }
  }

  // About panel (shown by the "About Skipper" menu item on macOS)
  const aboutIconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(__dirname, "../build/icon.png");
  app.setAboutPanelOptions({
    applicationName: "Skipper",
    applicationVersion: app.getVersion(),
    copyright: "© 2026 NextEpochs",
    credits: "Your AI-powered second brain.",
    ...(existsSync(aboutIconPath) ? { iconPath: aboutIconPath } : {}),
  });

  setupMenu();

  // Auth manager: load any persisted session and start broadcasting state
  // changes to the renderer. safeStorage requires app.ready, so this must
  // happen here and not at module scope.
  // Dev-only companion to the password-store=basic switch above: Electron
  // reports the basic_text backend as unavailable unless plain-text use is
  // opted into explicitly.
  if (isDev && process.platform === "linux") {
    safeStorage.setUsePlainTextEncryption(true);
  }
  authManager = new AuthManager();
  authManager.onChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("skipper:auth:stateChanged", state);
    }
    // Sign-in/out changes the supporter entitlement → refresh the update
    // credentials and the "via" label instead of waiting for the next
    // periodic check.
    updaterRecheck?.();
    // Accounts changed → repoll the orchestrator (debounced).
    orchestratorPoke?.();
  });
  await authManager.init();

  try {
    if (!isDev) {
      const webRoot = getWebRoot();
      if (!existsSync(join(webRoot, "index.html"))) {
        throw new Error(
          `Web UI not found at: ${webRoot}. The static export (apps/web/out) is missing from this build.`,
        );
      }
      registerAppProtocol(webRoot);
    }
    createWindow();
    // Auto-update (official builds only). The updater + electron-updater are
    // esbuild-bundled into dist/updater.cjs because the packaged node_modules
    // carries only node-pty; a missing/broken bundle must never block startup.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initUpdater, recheckUpdates } = require("./updater.cjs") as {
        initUpdater: (
          g: () => BrowserWindow | null,
          onBeforeQuit?: () => Promise<void>,
          credentialsProvider?: () => Promise<{ entitlement?: string | null; license?: string | null }>,
        ) => void;
        recheckUpdates: () => void;
      };
      initUpdater(
        () => mainWindow,
        async () => {
          // Everything that could hold the install hostage dies BEFORE
          // quitAndInstall: pty shells (conhost children) and any coding/
          // planning agent children that would block the NSIS file
          // replacement on Windows.
          shuttingDown = true;
          coderKillAll?.();
          plannerKillAll?.();
          rescoreKillAll?.();
          killAllPtySessions();
        },
        getUpdateCredentials,
      );
      updaterRecheck = recheckUpdates;
    } catch (e) {
      console.warn("[updates] updater bundle unavailable:", e instanceof Error ? e.message : e);
    }
    // Orchestrator (issue #6). Bundled like the updater because it pulls in
    // the ESM @skipper/core; a broken bundle must never block startup.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initOrchestrator, pokeOrchestrator, killAllCodingRuns, killAllPlanningRuns, killAllRescores } = require("./orchestrator.cjs") as typeof import("./orchestrator");
      initOrchestrator(() => mainWindow, {
        getAccounts: () => authManager?.getState().accounts ?? [],
        getToken: (key, force) =>
          authManager?.getAccessToken(key, force) ?? Promise.resolve(null),
        cursorFilePath: join(app.getPath("userData"), "inbox-cursors.json"),
        manifestFilePath: join(app.getPath("userData"), "orchestrator-manifest.json"),
        repoLinksFilePath: join(app.getPath("userData"), "repo-links.json"),
        plansDir: join(app.getPath("userData"), "plans"),
        worktreesDir: join(app.getPath("userData"), "worktrees"),
        memoryDir: join(app.getPath("userData"), "memory"),
        dataDir: getLlmSettingsDir(),
        cliBundlePath: cliBundlePath(),
      });
      orchestratorPoke = pokeOrchestrator;
      coderKillAll = killAllCodingRuns;
      plannerKillAll = killAllPlanningRuns;
      rescoreKillAll = killAllRescores;
    } catch (e) {
      console.warn("[orchestrator] bundle unavailable:", e instanceof Error ? e.message : e);
    }
  } catch (err) {
    console.error("Failed to start:", err);
    dialog.showErrorBox(
      "Skipper failed to start",
      `${err instanceof Error ? err.message : String(err)}\n\nPlease report this at github.com/cicababba/skipper/issues`,
    );
    app.quit();
  }

  app.on("activate", () => {
    // Never respawn a window mid-quit: it would just render black until the
    // process exits.
    if (shuttingDown) return;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  shuttingDown = true;
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shuttingDown = true;
  // Drop the dock icon immediately: while the (bounded) teardown runs, a
  // still-clickable icon could relaunch into a black window.
  if (process.platform === "darwin") app.dock?.hide();
  // Live node-pty children (integrated terminals) and coding agents keep the
  // process alive past app.quit() — the classic "window gone, app still in
  // the dock" zombie.
  coderKillAll?.();
  plannerKillAll?.();
  rescoreKillAll?.();
  killAllPtySessions();
  armQuitFailsafe();
});

// Force-exit that takes the WHOLE TREE down. On Windows a plain SIGKILL
// (TerminateProcess) leaves children alive — pty conhosts and coding-agent
// children orphan and can block the NSIS updater until killed manually.
// taskkill /T terminates the whole tree (pty conhosts and all).
function forceExitNow(): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(process.pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      /* fall through to SIGKILL */
    }
    // If taskkill itself fails to land, SIGKILL at least kills the main.
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 1500);
    return;
  }
  process.kill(process.pid, "SIGKILL");
}

// Belt-and-braces: once a quit is underway, the process MUST die. If any
// native handle (pty, fsevents) still wedges the event loop,
// force the exit. quitAndInstall spawns its installer before this can fire.
let quitFailsafeArmed = false;
function armQuitFailsafe(): void {
  if (quitFailsafeArmed) return;
  quitFailsafeArmed = true;
  setTimeout(() => {
    // Skip all native teardown (a wedged fsevents handle abort()s there and
    // the user sees a crash report for what was just a quit) — but take the
    // children along: see forceExitNow.
    console.warn("[quit] event loop still alive 2.5s after quit — force exit");
    forceExitNow();
  }, 2500);
}


// If the GPU process dies (the usual cause of a black window after sleep/
// occlusion), reload the renderer to rebuild its compositor surface rather than
// leaving the user staring at black until they restart.
app.on("child-process-gone", (_e, details) => {
  if (details.type === "GPU" && !shuttingDown) {
    console.error("[gpu] process gone:", details.reason);
    mainWindow?.webContents.reload();
  }
});
