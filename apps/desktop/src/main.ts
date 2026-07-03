import {
  app,
  BrowserWindow,
  shell,
  Menu,
  ipcMain,
  dialog,
  utilityProcess,
  UtilityProcess,
  powerMonitor,
  powerSaveBlocker,
} from "electron";
import { createServer } from "node:net";
import { join, dirname, resolve, sep, basename } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  cpSync,
  renameSync,
  rmSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { execFileSync, execSync, spawn } from "node:child_process";
import { AuthManager } from "./auth";
import { SyncManager } from "./sync";
import { TeamManager } from "./team";
import { modulesFromLicense } from "./modules";
import { loadDevModule, type DevModuleApi } from "./dev-module";

// Set once the lazy updater bundle loads; lets team connect/disconnect refresh
// the update credentials + "via" label immediately.
let updaterRecheck: (() => void) | null = null;

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

const isDev = !!process.env.NESTBRAIN_DEV;
const DEV_URL = "http://localhost:3000";

// Must be set before app is ready so the menu bar shows "NestBrain" not "Electron"
app.setName("NestBrain");

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
// process exits immediately and the existing window comes to front. NestBrain
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
let nextServer: UtilityProcess | null = null;
let serverUrl: string | null = null;
let currentPort: number | null = null;
let lastServerOutput = "";
let authManager: AuthManager | null = null;
let syncManager: SyncManager | null = null;
let teamManager: TeamManager | null = null;

// Core workspace dirs — created for every install. Projects/ belongs to the
// Dev module (created lazily when the module is entitled) and Team/ to the
// Team Server (created on connect); neither is scaffolded for source/$29
// installs. Both stay in the protected list so they can't be deleted/renamed
// from the file tree once they exist.
const CORE_SUBDIRS = [
  "Business",
  "Context",
  "Daily",
  "Library",
  "Skills",
];
const NESTBRAIN_SUBDIRS = [...CORE_SUBDIRS, "Projects", "Team"];

interface Bootstrap {
  nestBrainPath?: string;
}

function getBootstrapPath(): string {
  return join(app.getPath("userData"), "bootstrap.json");
}

function readBootstrap(): Bootstrap {
  try {
    const raw = readFileSync(getBootstrapPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeBootstrap(b: Bootstrap): void {
  const p = getBootstrapPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(b, null, 2), "utf-8");
}

// One-time migration from the legacy `.mindnest/` internal state dir to
// the new `.nestbrain/` (post-rebrand from MindNest → NestBrain). Only
// renames if the legacy dir exists and the new one doesn't, so it's safe
// to call repeatedly.
function migrateLegacyInternalDir(nestBrainPath: string): void {
  const legacy = join(nestBrainPath, ".mindnest");
  const current = join(nestBrainPath, ".nestbrain");
  if (existsSync(legacy) && !existsSync(current)) {
    try {
      renameSync(legacy, current);
      console.log(`[migrate] renamed ${legacy} → ${current}`);
    } catch (err) {
      console.warn(`[migrate] failed to rename internal dir:`, err);
    }
  }
}

function getDataDir(): string {
  const bootstrap = readBootstrap();
  if (bootstrap.nestBrainPath && existsSync(bootstrap.nestBrainPath)) {
    migrateLegacyInternalDir(bootstrap.nestBrainPath);
    const dir = join(bootstrap.nestBrainPath, ".nestbrain");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }
  // First-run fallback
  const dir = join(app.getPath("userData"), "data-tmp");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getWikiDir(): string | null {
  const bootstrap = readBootstrap();
  if (bootstrap.nestBrainPath && existsSync(bootstrap.nestBrainPath)) {
    const dir = join(bootstrap.nestBrainPath, "Library", "Knowledge");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }
  return null;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("Failed to get free port"));
      }
    });
  });
}

async function startNextServer(reusePort = false): Promise<string> {
  const port = reusePort && currentPort ? currentPort : await findFreePort();
  currentPort = port;
  const dataDir = getDataDir();
  const wikiDir = getWikiDir();

  const resourcesRoot = app.isPackaged
    ? join(process.resourcesPath, "web")
    : join(__dirname, "../../web/.next/standalone");

  const serverJs = join(resourcesRoot, "apps/web/server.js");

  if (!existsSync(serverJs)) {
    throw new Error(`Next.js standalone server not found at: ${serverJs}`);
  }

  nextServer = utilityProcess.fork(serverJs, [], {
    cwd: join(resourcesRoot, "apps/web"),
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NESTBRAIN_DATA_DIR: dataDir,
      ...(wikiDir ? { NESTBRAIN_WIKI_DIR: wikiDir } : {}),
      // Writable, update-surviving cache for the local embedding model
      // (downloaded from huggingface.co on first use).
      NESTBRAIN_HF_CACHE: join(app.getPath("userData"), "hf-cache"),
      NODE_ENV: "production",
    },
    stdio: "pipe",
    serviceName: "nestbrain-next-server",
  });

  lastServerOutput = "";
  nextServer.stdout?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    console.log("[next]", line);
    lastServerOutput += line + "\n";
    if (lastServerOutput.length > 8000) lastServerOutput = lastServerOutput.slice(-6000);
  });
  nextServer.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    console.error("[next]", line);
    lastServerOutput += "[stderr] " + line + "\n";
    if (lastServerOutput.length > 8000) lastServerOutput = lastServerOutput.slice(-6000);
  });
  nextServer.on("exit", (code: number) => {
    console.log(`[next] exited with code ${code}`);
    // Only quit if the main window closed. If we killed it for a restart, don't quit.
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
      // Server died unexpectedly — leave window open with whatever is cached
    }
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url, 60000);
  return url;
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();

  // If the server process exits (crash, missing module, etc.) reject
  // immediately instead of polling until timeout.
  let serverExited = false;
  let exitReason = "";
  const onExit = (code: number) => {
    serverExited = true;
    exitReason = `Server process exited with code ${code}`;
  };
  nextServer?.on("exit", onExit);

  try {
    while (Date.now() - start < timeoutMs) {
      if (serverExited) {
        const output = lastServerOutput
          ? `\n\nServer output:\n${lastServerOutput.slice(-3000)}`
          : "\n\n(no output captured)";
        throw new Error(`${exitReason}${output}`);
      }
      try {
        // ANY HTTP response (even 500) means the server is alive and
        // listening. A 500 just means a page render error (e.g. a native
        // module failed to load on this platform) — the app can still
        // show the UI and the user gets a visible error instead of a
        // silent quit. Only ECONNREFUSED (caught below) means "not ready".
        await fetch(url);
        return;
      } catch {
        // ECONNREFUSED — server hasn't bound the port yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const output = lastServerOutput
      ? `\n\nServer output:\n${lastServerOutput.slice(-3000)}`
      : "\n\n(no output captured from server process)";
    throw new Error(
      `Next.js server did not respond within ${timeoutMs / 1000}s.${output}`,
    );
  } finally {
    nextServer?.removeListener("exit", onExit);
  }
}

let shuttingDown = false;

function killNextServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!nextServer) return resolve();
    const srv = nextServer;
    nextServer = null;
    srv.once("exit", () => resolve());
    try {
      srv.kill();
    } catch {
      resolve();
    }
    // Safety timeout
    setTimeout(resolve, 2000);
  });
}

async function restartNextServer(): Promise<void> {
  // In dev the Next.js server is run externally (`pnpm --filter @nestbrain/web dev`)
  // and we don't manage its lifecycle from here. A NestBrain location change
  // means the dev server is now pointing at a stale data dir, but a hard
  // restart of that external process is outside our control — log and move on.
  if (isDev) {
    console.warn("[dev] NestBrain location changed; restart `pnpm --filter @nestbrain/web dev` manually to pick up the new data dir");
    return;
  }
  await killNextServer();
  // Give the OS a moment to release the port (TIME_WAIT)
  await new Promise((r) => setTimeout(r, 300));
  // Reuse the same port so the renderer's API calls transparently hit the new server
  // without requiring a page reload (which would wipe React state mid-onboarding)
  let attempts = 0;
  while (attempts < 5) {
    try {
      serverUrl = await startNextServer(true);
      return;
    } catch (err) {
      attempts++;
      if (attempts >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

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
        buttons: ["Quit NestBrain", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: "Quit NestBrain?",
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

  const url = isDev ? DEV_URL : serverUrl;
  if (url) mainWindow.loadURL(url);
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
          label: "About NestBrain",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show();
              mainWindow.webContents.send("nestbrain:show-about");
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
ipcMain.handle("nestbrain:openExternal", (_e, url: string) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) void shell.openExternal(url);
});

ipcMain.handle("nestbrain:getBootstrap", () => {
  return {
    ...readBootstrap(),
    isElectron: true,
    platform: process.platform,
  };
});

ipcMain.handle("nestbrain:selectDirectory", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose where to create NestBrain",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Select",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ====== CLI plumbing shared with the Dev module ======

/** Command the installed hook should invoke at commit time. */
function hookCliCommand(): string {
  const target = cliInstallTarget();
  if (target && existsSync(target)) return "nestbrain"; // installed on PATH → survives moves
  return cliWrapperSource(); // bundled wrapper (absolute path)
}

/** Run the bundled (or PATH) nestbrain CLI. */
function runNestbrainCli(args: string[]): void {
  let onPath = false;
  try {
    execSync(process.platform === "win32" ? "where nestbrain" : "command -v nestbrain", { stdio: "ignore" });
    onPath = true;
  } catch {
    /* not on PATH */
  }
  const cmd = onPath ? "nestbrain" : cliWrapperSource();
  execFileSync(cmd, args, { stdio: "ignore", timeout: 60_000, shell: process.platform === "win32" });
}

// ====== Dev module (Enterprise add-on) ======
// Terminal, git and Projects backends live in the private nestbrain-modules
// repo (open-core). Public source builds have no impl → knowledge core only.
const devModule: DevModuleApi | null = loadDevModule({
  ipcMain,
  dialog,
  getMainWindow: () => mainWindow,
  getNestBrainPath: () => readBootstrap().nestBrainPath ?? null,
  runNestbrainCli,
  hookCliCommand,
});

// === Directory listing (for file tree) ===
interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

function isHiddenOrIgnored(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "node_modules" ||
    name === ".nestbrain"
  );
}

ipcMain.handle(
  "nestbrain:fs:list",
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
  "nestbrain:fs:createDir",
  (_e, dirPath: string): { ok: true; path: string } => {
    // Containment check — createDir must stay within the active NestBrain
    // (used for New Project and for the in-tree new-folder action).
    const abs = assertInsideNestBrain(dirPath);
    mkdirSync(abs, { recursive: true });
    return { ok: true, path: abs };
  },
);

// ===== File read/write for the in-app editor =====
// Both handlers enforce that the target path is inside the active
// NestBrain root, so the renderer cannot read or write arbitrary files
// elsewhere on the user's disk even if the preload is compromised.
const MAX_EDITABLE_BYTES = 1024 * 1024; // 1 MiB hard cap for the editor

interface ReadFileResult {
  content: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
}

function assertInsideNestBrain(targetPath: string): string {
  const bootstrap = readBootstrap();
  if (!bootstrap.nestBrainPath) {
    throw new Error("No NestBrain configured");
  }
  const root = resolve(bootstrap.nestBrainPath);
  const abs = resolve(targetPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(
      `Refusing to access path outside NestBrain: ${abs}`,
    );
  }
  return abs;
}

function looksBinary(buf: Buffer): boolean {
  // Cheap heuristic: null byte in the first 8KB → binary
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

ipcMain.handle(
  "nestbrain:fs:readFile",
  (_e, filePath: string): ReadFileResult => {
    const abs = assertInsideNestBrain(filePath);
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
  "nestbrain:fs:writeFile",
  (_e, filePath: string, content: string): { ok: true; size: number } => {
    const abs = assertInsideNestBrain(filePath);
    // Refuse to write into .nestbrain/ — that's internal state the user
    // should never hand-edit through the app's editor.
    const bootstrap = readBootstrap();
    const internal = resolve(bootstrap.nestBrainPath!, ".nestbrain");
    if (abs === internal || abs.startsWith(internal + sep)) {
      throw new Error("Cannot write into .nestbrain/ — internal state");
    }
    // Ensure parent directory exists
    const parent = join(abs, "..");
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(abs, content, "utf-8");
    return { ok: true, size: Buffer.byteLength(content, "utf-8") };
  },
);

// Paths inside NestBrain that cannot be deleted or renamed — these are
// either workspace-structural (top-level skeleton dirs) or internal state.
const PROTECTED_TOP_LEVEL_NAMES = new Set([
  ...NESTBRAIN_SUBDIRS,
  ".nestbrain",
]);

function isProtectedPath(abs: string): boolean {
  const bootstrap = readBootstrap();
  if (!bootstrap.nestBrainPath) return true;
  const root = resolve(bootstrap.nestBrainPath);
  if (abs === root) return true;
  const internal = resolve(root, ".nestbrain");
  if (abs === internal || abs.startsWith(internal + sep)) return true;
  const rel = abs.slice(root.length + 1);
  if (!rel.includes(sep) && PROTECTED_TOP_LEVEL_NAMES.has(rel)) return true;
  return false;
}

ipcMain.handle(
  "nestbrain:fs:delete",
  (_e, targetPath: string): { ok: true } => {
    const abs = assertInsideNestBrain(targetPath);
    if (isProtectedPath(abs)) {
      throw new Error(
        "This path is protected by NestBrain and cannot be deleted.",
      );
    }
    if (!existsSync(abs)) {
      throw new Error("Path does not exist");
    }
    rmSync(abs, { recursive: true, force: true });
    return { ok: true };
  },
);

ipcMain.handle(
  "nestbrain:fs:rename",
  (
    _e,
    oldPath: string,
    newName: string,
  ): { ok: true; newPath: string } => {
    const absOld = assertInsideNestBrain(oldPath);
    if (isProtectedPath(absOld)) {
      throw new Error(
        "This path is protected by NestBrain and cannot be renamed.",
      );
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
    // Must still end up inside NestBrain (extra safety)
    assertInsideNestBrain(absNew);
    if (existsSync(absNew)) {
      throw new Error(`A file or folder named "${trimmed}" already exists`);
    }
    renameSync(absOld, absNew);
    return { ok: true, newPath: absNew };
  },
);

// ===== Trash: soft-deleted files (list / restore / empty) =====
// Sync soft-deletes land in <workspace>/.trash/. Cross-OS: pure node:path/fs,
// no separator assumptions.
interface TrashEntry {
  id: string;
  name: string;
  originalPath: string;
  size: number;
  deletedAt: number;
}

function trashDir(): string | null {
  const b = readBootstrap();
  return b.nestBrainPath ? join(b.nestBrainPath, ".trash") : null;
}

/** Workspace-relative path a trashed file restores to. Team-sync layout is
 *  `.trash/team-<ts>/<path>`; the Drive engine's is `.trash/<path>`. */
function trashOriginalRel(relUnderTrash: string): string {
  const parts = relUnderTrash.split(sep);
  return parts[0]?.startsWith("team-") ? parts.slice(1).join(sep) : relUnderTrash;
}

function walkTrash(dir: string, base: string, out: TrashEntry[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walkTrash(abs, base, out);
    else if (e.isFile()) {
      const rel = abs.slice(base.length + 1);
      let st = null;
      try { st = statSync(abs); } catch { /* ignore */ }
      out.push({
        id: rel,
        name: e.name,
        originalPath: trashOriginalRel(rel).split(sep).join("/"),
        size: st?.size ?? 0,
        deletedAt: st?.mtimeMs ?? 0,
      });
    }
  }
}

ipcMain.handle("nestbrain:trash:list", (): TrashEntry[] => {
  const td = trashDir();
  if (!td || !existsSync(td)) return [];
  const out: TrashEntry[] = [];
  walkTrash(td, td, out);
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
});

ipcMain.handle("nestbrain:trash:restore", (_e, id: string): { ok: true; restoredTo: string } => {
  const td = trashDir();
  const b = readBootstrap();
  if (!td || !b.nestBrainPath) throw new Error("No NestBrain configured");
  if (id.includes("..")) throw new Error("invalid id");
  const src = join(td, id);
  if (!existsSync(src)) throw new Error("Trash item no longer exists");
  let dest = join(b.nestBrainPath, trashOriginalRel(id));
  if (existsSync(dest)) {
    const ext = dest.includes(".") ? dest.slice(dest.lastIndexOf(".")) : "";
    dest = (ext ? dest.slice(0, -ext.length) : dest) + `.restored-${Date.now()}` + ext;
  }
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  return { ok: true, restoredTo: dest };
});

ipcMain.handle("nestbrain:trash:empty", (): { ok: true } => {
  const td = trashDir();
  if (td && existsSync(td)) rmSync(td, { recursive: true, force: true });
  return { ok: true };
});

// ===== Session handoff: run the bundled `nestbrain session` CLI, capture output =====
ipcMain.handle(
  "nestbrain:session:run",
  (_e, mode: "save" | "resume", projectDir: string): Promise<{ ok: boolean; output: string }> => {
    if (mode !== "save" && mode !== "resume") throw new Error("invalid mode");
    const abs = assertInsideNestBrain(projectDir);
    return new Promise((resolveP) => {
      let onPath = false;
      try {
        execSync(process.platform === "win32" ? "where nestbrain" : "command -v nestbrain", { stdio: "ignore" });
        onPath = true;
      } catch { /* not on PATH → use bundled wrapper */ }
      const cmd = onPath ? "nestbrain" : cliWrapperSource();
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

function getSkeletonPath(): string {
  // Packaged: resources/skeleton. Dev: repo_root/skeleton.
  if (app.isPackaged) {
    return join(process.resourcesPath, "skeleton");
  }
  return resolve(__dirname, "../../../skeleton");
}

function copySkeletonToNestBrain(nestBrainPath: string): void {
  const skeletonPath = getSkeletonPath();
  if (!existsSync(skeletonPath)) return;

  // CLAUDE.md in the NestBrain root — only write if missing (preserve user edits on re-setup)
  const claudeSrc = join(skeletonPath, "CLAUDE.md");
  const claudeDst = join(nestBrainPath, "CLAUDE.md");
  if (existsSync(claudeSrc) && !existsSync(claudeDst)) {
    cpSync(claudeSrc, claudeDst);
  }

  // Skills — copy each skill folder into NestBrain/Skills/ only if missing
  const skillsSrc = join(skeletonPath, "Skills");
  const skillsDst = join(nestBrainPath, "Skills");
  if (existsSync(skillsSrc)) {
    mkdirSync(skillsDst, { recursive: true });
    for (const entry of readdirSync(skillsSrc)) {
      const src = join(skillsSrc, entry);
      const dst = join(skillsDst, entry);
      if (statSync(src).isDirectory() && !existsSync(dst)) {
        cpSync(src, dst, { recursive: true });
      }
    }
  }
}

function createFreshNestBrain(nestBrainPath: string): void {
  mkdirSync(nestBrainPath, { recursive: true });
  for (const sub of CORE_SUBDIRS) {
    mkdirSync(join(nestBrainPath, sub), { recursive: true });
  }
  // NestBrain-generated wiki lives inside the user-visible Library folder
  mkdirSync(join(nestBrainPath, "Library", "Knowledge"), { recursive: true });
  // .nestbrain holds internal state (raw sources, settings, vector index)
  mkdirSync(join(nestBrainPath, ".nestbrain"), { recursive: true });
  // Seed CLAUDE.md and Skills from the bundled skeleton (non-destructive)
  copySkeletonToNestBrain(nestBrainPath);
}

function moveDir(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV") {
      // Cross-device move — fall back to copy + delete
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

// ===== NestBrain auto-refresh watcher =====
// Recursively watches the NestBrain directory and emits a debounced
// `nestbrain:fs:changed` event to the renderer so the file tree refreshes
// automatically when files are added/modified/removed from Finder, the
// terminal, or any other source.
//
// Uses fs.watch with { recursive: true } which is supported on macOS and
// Windows (our target platforms). Debounced at 500ms so bursts of events
// (e.g. npm install, git operations) collapse into a single refresh.
// Noise from .nestbrain/, .git/, node_modules/, and temp files is filtered
// in-process so the IPC channel stays quiet.
let fsWatcher: FSWatcher | null = null;
let fsWatchDebounce: NodeJS.Timeout | null = null;
const FS_WATCH_DEBOUNCE_MS = 1200;

function shouldIgnoreFsChange(filename: string | null): boolean {
  if (!filename) return false;
  const f = filename.replace(/\\/g, "/");
  // Hidden / internal directories
  if (f === ".nestbrain" || f.startsWith(".nestbrain/")) return true;
  if (f === ".git" || f.startsWith(".git/") || f.includes("/.git/")) return true;
  if (
    f === "node_modules" ||
    f.startsWith("node_modules/") ||
    f.includes("/node_modules/")
  ) {
    return true;
  }
  // Noise files
  const base = f.split("/").pop() || "";
  if (base === ".DS_Store" || base === "Thumbs.db") return true;
  // The local vector index is rewritten on every (team) compile/index — large
  // and irrelevant to the tree; ignoring it kills a big source of churn.
  if (base === "vector-index.json") return true;
  if (
    base.endsWith(".swp") ||
    base.endsWith(".swx") ||
    base.endsWith(".tmp") ||
    base.endsWith("~")
  ) {
    return true;
  }
  return false;
}

function startNestBrainWatcher(nestBrainPath: string): void {
  stopNestBrainWatcher();
  if (!existsSync(nestBrainPath)) return;
  try {
    fsWatcher = watch(
      nestBrainPath,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        if (shouldIgnoreFsChange(filename)) return;
        if (fsWatchDebounce) clearTimeout(fsWatchDebounce);
        fsWatchDebounce = setTimeout(() => {
          fsWatchDebounce = null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("nestbrain:fs:changed");
          }
        }, FS_WATCH_DEBOUNCE_MS);
      },
    );
    fsWatcher.on("error", (err) => {
      console.error("[watcher] error:", err);
    });
    console.log(`[watcher] watching ${nestBrainPath}`);
  } catch (err) {
    console.error("[watcher] failed to start:", err);
  }
}

function stopNestBrainWatcher(): void {
  if (fsWatchDebounce) {
    clearTimeout(fsWatchDebounce);
    fsWatchDebounce = null;
  }
  if (fsWatcher) {
    try {
      fsWatcher.close();
    } catch {
      /* ignore */
    }
    fsWatcher = null;
  }
}

ipcMain.handle("nestbrain:setupNestBrain", async (_e, parentPath: string) => {
  if (!parentPath || typeof parentPath !== "string") {
    throw new Error("Invalid parent path");
  }
  const nestBrainPath = join(parentPath, "NestBrain");
  createFreshNestBrain(nestBrainPath);

  writeBootstrap({ nestBrainPath });
  // Restart Next.js server so it picks up the new data dir
  await restartNextServer();
  // Start watching the freshly created NestBrain for file tree auto-refresh
  startNestBrainWatcher(nestBrainPath);

  // Notify the renderer so the sidebar / file tree pick up the new
  // workspace path immediately at the end of onboarding (without needing
  // an app restart). Reuses the same channel as the move handler.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("nestbrain:nestBrainMoved", {
      nestBrainPath,
    });
  }

  return { nestBrainPath };
});

ipcMain.handle(
  "nestbrain:moveOrCreateNestBrain",
  async (_e, parentPath: string) => {
    if (!parentPath || typeof parentPath !== "string") {
      throw new Error("Invalid parent path");
    }
    const newPath = join(parentPath, "NestBrain");
    const bootstrap = readBootstrap();
    const oldPath = bootstrap.nestBrainPath;

    // Same destination as current → no-op
    if (oldPath && resolve(oldPath) === resolve(newPath)) {
      return { nestBrainPath: newPath, moved: false, created: false };
    }

    // Refuse if something is already at the destination
    if (existsSync(newPath)) {
      throw new Error(
        `A folder named "NestBrain" already exists at ${parentPath}. Choose a different location or remove it first.`,
      );
    }

    // Close terminals, stop the watcher, and stop the Next.js server —
    // they all hold references to the old data dir (terminal cwd, watch
    // handles, open file handles, env vars). In dev the Next server is
    // external (next dev), so we skip the kill+restart dance — the user
    // will need to restart `pnpm --filter @nestbrain/web dev` manually.
    devModule?.killAllPtySessions();
    stopNestBrainWatcher();
    if (!isDev) await killNextServer();

    let moved = false;
    let created = false;

    if (oldPath && existsSync(oldPath)) {
      // Move existing NestBrain to the new location
      mkdirSync(parentPath, { recursive: true });
      moveDir(oldPath, newPath);
      moved = true;
    } else {
      // No existing NestBrain — create fresh at the new location
      createFreshNestBrain(newPath);
      created = true;
    }

    writeBootstrap({ nestBrainPath: newPath });

    // Give the OS a moment to release the port, then restart Next.js
    // reusing the same port so the renderer's fetch calls transparently
    // hit the new server without a window reload. Skipped in dev (see above).
    if (!isDev) {
      await new Promise((r) => setTimeout(r, 300));
      let attempts = 0;
      while (attempts < 5) {
        try {
          serverUrl = await startNextServer(true);
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 5) throw err;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    // Restart the file watcher on the new NestBrain location
    startNestBrainWatcher(newPath);

    // Notify the renderer so it can refresh file tree, terminal state, etc.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("nestbrain:nestBrainMoved", {
        nestBrainPath: newPath,
      });
    }

    return { nestBrainPath: newPath, moved, created };
  },
);

// === Auth (Google OAuth) ===
ipcMain.handle("nestbrain:auth:getState", () => {
  return authManager?.getState() ?? { status: "signed-out" };
});

ipcMain.handle("nestbrain:auth:signIn", async () => {
  if (!authManager) throw new Error("Auth not initialized");
  await authManager.signIn();
});

ipcMain.handle("nestbrain:auth:signOut", async () => {
  if (!authManager) throw new Error("Auth not initialized");
  await authManager.signOut();
});

ipcMain.handle("nestbrain:auth:cancelSignIn", () => {
  authManager?.cancelSignIn();
});

// === Sync ===
ipcMain.handle("nestbrain:sync:getState", () => {
  return syncManager?.getState() ?? null;
});

ipcMain.handle("nestbrain:sync:setPreferences", async (_e, prefs) => {
  if (!syncManager) throw new Error("Sync not initialized");
  await syncManager.setPreferences(prefs);
});

ipcMain.handle("nestbrain:sync:syncNow", async () => {
  if (!syncManager) throw new Error("Sync not initialized");
  await syncManager.syncNow();
});

ipcMain.handle("nestbrain:sync:cancel", () => {
  syncManager?.cancel();
});

ipcMain.handle("nestbrain:sync:softDelete", async (_e, relPath: string) => {
  if (!syncManager) throw new Error("Sync not initialized");
  if (typeof relPath !== "string" || relPath === "") throw new Error("Invalid path");
  await syncManager.softDelete(relPath);
});

ipcMain.handle("nestbrain:sync:hardDelete", async (_e, relPath: string) => {
  if (!syncManager) throw new Error("Sync not initialized");
  if (typeof relPath !== "string" || relPath === "") throw new Error("Invalid path");
  await syncManager.hardDelete(relPath);
});

// ====== Team Knowledge (Enterprise) ======

ipcMain.handle("nestbrain:team:getState", () => {
  return teamManager?.getState() ?? { status: "disconnected", syncing: false };
});

// ====== Modules (Enterprise add-ons) ======
// Enabled = built into this binary AND licensed via `module:<id>` features in
// the org license the Team Server hands to signed-in members.
ipcMain.handle("nestbrain:modules:get", async (): Promise<string[]> => {
  const token = (await teamManager?.getOrgLicense().catch(() => null)) ?? null;
  const mods = modulesFromLicense(token);
  // Module dirs are created lazily, on entitlement: Projects/ exists only
  // where the Dev module does.
  if (mods.includes("dev")) {
    const b = readBootstrap();
    if (b.nestBrainPath) {
      try { mkdirSync(join(b.nestBrainPath, "Projects"), { recursive: true }); } catch { /* ignore */ }
    }
  }
  if (mods.includes("anatomize")) {
    void teamManager?.syncAnatomizeProfiles();
  }
  return mods;
});
ipcMain.handle("nestbrain:team:connect", async (_e, serverUrl: string, email: string, password: string) => {
  if (!teamManager) throw new Error("Team not initialized");
  await teamManager.connect(serverUrl, email, password);
});
ipcMain.handle("nestbrain:team:setup", async (_e, serverUrl: string, token: string, email: string, password: string, name?: string) => {
  if (!teamManager) throw new Error("Team not initialized");
  await teamManager.setup(serverUrl, token, email, password, name);
});
ipcMain.handle("nestbrain:team:disconnect", async () => {
  if (!teamManager) return;
  await teamManager.disconnect();
});
ipcMain.handle("nestbrain:team:listMembers", async () => {
  if (!teamManager) throw new Error("Team not initialized");
  return teamManager.listMembers();
});
ipcMain.handle("nestbrain:team:addMember", async (_e, m: { email: string; name: string; password: string; role: string }) => {
  if (!teamManager) throw new Error("Team not initialized");
  return teamManager.addMember(m);
});
ipcMain.handle("nestbrain:team:removeMember", async (_e, id: string) => {
  if (!teamManager) throw new Error("Team not initialized");
  return teamManager.removeMember(id);
});
ipcMain.handle("nestbrain:team:selectWorkspace", async (_e, id: string) => {
  if (!teamManager) throw new Error("Team not initialized");
  await teamManager.selectWorkspace(id);
});
ipcMain.handle("nestbrain:team:syncNow", async () => {
  if (!teamManager) throw new Error("Team not initialized");
  return teamManager.syncNow();
});

ipcMain.handle("nestbrain:team:setIncludeProjects", async (_e, v: boolean) => {
  if (!teamManager) throw new Error("Team not initialized");
  await teamManager.setIncludeProjects(!!v);
});

ipcMain.handle("nestbrain:team:switch", async (_e, serverUrl: string, email: string, password: string) => {
  if (!teamManager) throw new Error("Team not initialized");
  await teamManager.switchServer(serverUrl, email, password);
});

// ====== CLI on PATH (macOS / Windows) ======

/**
 * Where the user's PATH-installed `nestbrain` symlink/wrapper lives.
 * - macOS: /usr/local/bin/nestbrain (matches Homebrew's bin and VS Code's
 *   `code` command convention). Requires sudo to write.
 * - Windows: %LOCALAPPDATA%/NestBrain/cli/nestbrain.bat — user-scoped so
 *   no admin prompt is needed; the install also appends that dir to the
 *   user-level PATH via setx.
 */
function cliInstallTarget(): string | null {
  if (process.platform === "darwin") return "/usr/local/bin/nestbrain";
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) return null;
    return join(local, "NestBrain", "cli", "nestbrain.bat");
  }
  return null;
}

/**
 * Absolute path of the CLI wrapper shipped with the running app.
 * In packaged mode: <App>/Contents/Resources/cli/nestbrain (macOS) or
 * <install-dir>/resources/cli/nestbrain.bat (Windows). In dev we point at
 * the source dir so install-on-PATH can be tested without packaging.
 */
function cliWrapperSource(): string {
  const wrapperName = process.platform === "win32" ? "nestbrain.bat" : "nestbrain";
  if (app.isPackaged) {
    return join(process.resourcesPath, "cli", wrapperName);
  }
  return join(__dirname, "../../desktop/build/cli", wrapperName);
}

interface CliStatus {
  supported: boolean;
  target: string | null;
  source: string;
  installed: boolean;
  /** True when target exists but points at the wrong place (e.g. app moved). */
  stale: boolean;
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

ipcMain.handle("nestbrain:cli:status", async () => getCliStatus());

ipcMain.handle("nestbrain:cli:install", async () => {
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
      "# NestBrain CLI launcher (managed by NestBrain — Settings → Command line)",
      "for w in \\",
      `  "${status.source}" \\`,
      '  "/Applications/NestBrain.app/Contents/Resources/cli/nestbrain" \\',
      '  "$HOME/Applications/NestBrain.app/Contents/Resources/cli/nestbrain"',
      "do",
      '  [ -x "$w" ] && exec "$w" "$@"',
      "done",
      'echo "nestbrain: NestBrain.app not found. Re-install the CLI from NestBrain → Settings → Command line." >&2',
      "exit 127",
      "",
    ].join("\n");
    const tmpLauncher = join(app.getPath("temp"), "nestbrain-cli-launcher");
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
    // User-scoped install into %LOCALAPPDATA%/NestBrain/cli + user PATH.
    // Generate a launcher that CALLS the wrapper inside the install dir by
    // absolute path — copying the .bat broke it: its %~dp0-relative bundle
    // lookup resolved against the copy's location, where nothing exists.
    const targetDir = dirname(status.target);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const launcher = [
      "@echo off",
      "REM NestBrain CLI launcher (managed by NestBrain - Settings > Command line)",
      `if exist "${status.source}" (`,
      `  call "${status.source}" %*`,
      "  exit /b %errorlevel%",
      ")",
      "echo nestbrain: NestBrain installation not found. Re-install the CLI from Settings ^> Command line. 1>&2",
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

ipcMain.handle("nestbrain:cli:uninstall", async () => {
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
// cache on disk. Enterprise: forward the org license from the Team Server.
const LICENSING_BASE = "https://license.nestbrain.app";
const ENTITLEMENT_FILE = () => join(app.getPath("userData"), "update-entitlement.json");

async function getSupporterEntitlement(): Promise<string | null> {
  try {
    const cached = JSON.parse(readFileSync(ENTITLEMENT_FILE(), "utf-8")) as { token?: string; exp?: number };
    // Reuse while >5 days of validity remain; refresh in the background after.
    if (cached.token && cached.exp && cached.exp * 1000 > Date.now() + 5 * 86400_000) {
      return cached.token;
    }
  } catch { /* no cache yet */ }

  const idToken = await authManager?.getIdToken();
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

async function getUpdateCredentials(): Promise<{ entitlement?: string | null; license?: string | null }> {
  const [entitlement, license] = await Promise.all([
    getSupporterEntitlement(),
    teamManager?.getOrgLicense() ?? Promise.resolve(null),
  ]);
  return { entitlement, license };
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

  // About panel (shown by the "About NestBrain" menu item on macOS)
  const aboutIconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(__dirname, "../build/icon.png");
  app.setAboutPanelOptions({
    applicationName: "NestBrain",
    applicationVersion: app.getVersion(),
    copyright: "© 2026 NextEpochs",
    credits: "Your AI-powered second brain.",
    ...(existsSync(aboutIconPath) ? { iconPath: aboutIconPath } : {}),
  });

  setupMenu();

  // Auth manager: load any persisted session and start broadcasting state
  // changes to the renderer. safeStorage requires app.ready, so this must
  // happen here and not at module scope.
  authManager = new AuthManager();
  authManager.onChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("nestbrain:auth:stateChanged", state);
    }
  });
  await authManager.init();

  // Sync manager depends on auth + a workspace path. It subscribes to auth
  // changes internally and recomputes its status (signed-in + enabled = idle;
  // anything else = disabled).
  syncManager = new SyncManager({
    authManager,
    getWorkspacePath: () => {
      const b = readBootstrap();
      return b.nestBrainPath ?? null;
    },
  });
  syncManager.onChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("nestbrain:sync:stateChanged", state);
    }
  });
  await syncManager.init();

  // Team Knowledge (Enterprise) — independent of Google auth; restores a
  // persisted session (token in keychain) and syncs Library/Knowledge against
  // a self-hosted Team Server.
  teamManager = new TeamManager({
    getWorkspacePath: () => {
      const b = readBootstrap();
      return b.nestBrainPath ?? null;
    },
    getServerUrl: () => serverUrl,
  });
  let teamWasConnected = false;
  teamManager.onChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("nestbrain:team:stateChanged", state);
    }
    // Connect/disconnect changes the update entitlement → refresh the
    // credentials and the "via" label instead of waiting for the next
    // periodic check.
    updaterRecheck?.();
    // Entering Team Server mode → turn OFF Google Drive sync (knowledge AND
    // projects). The Team Server owns Library/Knowledge; two engines on the same
    // tree would conflict. On disconnect we leave Drive off — the user re-enables
    // it deliberately.
    const nowConnected = state.status === "connected";
    if (nowConnected && !teamWasConnected) {
      void syncManager?.setPreferences({ enabled: false, includeProjects: false });
    }
    teamWasConnected = nowConnected;
  });
  await teamManager.init();

  try {
    if (!isDev) {
      serverUrl = await startNextServer();
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
          // quitAndInstall: drive watchers (deferred-quit dance), pty shells
          // (conhost children) and the Next utilityProcess (a second
          // NestBrain.exe that blocks the NSIS file replacement on Windows).
          await disposeWatchersForQuit();
          devModule?.killAllPtySessions();
          await killNextServer();
        },
        getUpdateCredentials,
      );
      updaterRecheck = recheckUpdates;
    } catch (e) {
      console.warn("[updates] updater bundle unavailable:", e instanceof Error ? e.message : e);
    }
    // Start watching NestBrain for file-tree auto-refresh if we already
    // have a bootstrap from a previous run. Fresh installs start it from
    // inside setupNestBrain after onboarding.
    const bootstrap = readBootstrap();
    if (bootstrap.nestBrainPath && existsSync(bootstrap.nestBrainPath)) {
      startNestBrainWatcher(bootstrap.nestBrainPath);
    }
  } catch (err) {
    console.error("Failed to start:", err);
    dialog.showErrorBox(
      "NestBrain failed to start",
      `${err instanceof Error ? err.message : String(err)}\n\nPlease report this at github.com/mikegazzaruso/nestbrain/issues`,
    );
    app.quit();
  }

  app.on("activate", () => {
    // Never respawn a window mid-quit: the embedded server is already dead and
    // the new window would just render black until the process exits.
    if (shuttingDown) return;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  shuttingDown = true;
  killNextServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  shuttingDown = true;
  // Drop the dock icon immediately: while the (bounded) teardown runs, a
  // still-clickable icon could relaunch into a black window.
  if (process.platform === "darwin") app.dock?.hide();
  stopNestBrainWatcher();
  killNextServer();
  // Live node-pty children (integrated terminals) keep the process alive past
  // app.quit() — the classic "window gone, app still in the dock" zombie.
  devModule?.killAllPtySessions();
  armQuitFailsafe();
});

// Force-exit that takes the WHOLE TREE down. On Windows a plain SIGKILL
// (TerminateProcess) leaves children alive — and our Next server is a
// utilityProcess, i.e. a second NestBrain.exe: orphaned, it blocks the NSIS
// updater with "NestBrain non può essere chiuso" until killed manually.
// taskkill /T terminates the tree (utility process, pty conhosts and all).
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
// native handle (pty, fsevents, utility process) still wedges the event loop,
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

// The sync + team managers own chokidar watchers whose macOS fsevents backend
// must be closed BEFORE Node tears down, or it fires into a freed N-API
// threadsafe function and aborts (SIGABRT) on quit. Defer the quit once while we
// await their disposal. Cross-platform safe (a no-op cost on Windows/Linux).
let watchersDisposed = false;

/**
 * Close the chokidar watchers before the process exits (fsevents aborts if
 * torn down after Node starts dying — see 1.7.5). Bounded by a short timeout: a
 * hung chokidar close() must never leave the app alive-but-windowless in the
 * dock. Idempotent so the updater can run it ahead of quitAndInstall.
 */
async function disposeWatchersForQuit(killOnTimeout = false): Promise<void> {
  if (watchersDisposed) return;
  shuttingDown = true;
  const clean = await Promise.race([
    Promise.allSettled([syncManager?.dispose(), teamManager?.dispose()]).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
  ]);
  watchersDisposed = true;
  if (!clean && killOnTimeout) {
    // A wedged fsevents handle abort()s during native teardown no matter how
    // we exit "gracefully" — the user would see a crash report for a plain
    // quit. Skip teardown entirely. The updater path passes false here: it
    // must reach quitAndInstall (which stages the installer) first, and the
    // armQuitFailsafe SIGKILL covers it afterwards.
    console.warn("[quit] watcher close timed out — SIGKILL to avoid the fsevents abort");
    process.kill(process.pid, "SIGKILL");
  }
}

app.on("will-quit", (event) => {
  if (watchersDisposed) return;
  // Deferring the quit breaks Squirrel's quitAndInstall flow, so the updater
  // path disposes BEFORE quitting (see updater.cjs prepareQuit); this handler
  // only covers ordinary quits (Cmd+Q, menu).
  event.preventDefault();
  void disposeWatchersForQuit(true).finally(() => app.quit());
});

// If the GPU process dies (the usual cause of a black window after sleep/
// occlusion), reload the renderer to rebuild its compositor surface rather than
// leaving the user staring at black until they restart.
app.on("child-process-gone", (_e, details) => {
  if (details.type === "GPU" && !shuttingDown) {
    console.error("[gpu] process gone:", details.reason);
    mainWindow?.webContents.reload();
  }
});
