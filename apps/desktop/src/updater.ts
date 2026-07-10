import { app, ipcMain, type BrowserWindow } from "electron";
import { UPDATE_BASE_URL, UPDATE_CHANNEL_KEY } from "./update-config";

// VS Code-style transparent auto-update, official builds only.
//
// The channel key is injected at build time (CI secret / .env.local) and is
// absent from source builds — without it this module stays inert and the
// update server rejects requests anyway. Flow: check on launch + every 6h →
// download silently in the background → tell the renderer to show a
// "Restart to update" toast → install on restart or on next quit.

export interface UpdateState {
  /** Why the updater is or isn't running. */
  status: "disabled" | "dev" | "idle" | "checking" | "downloading" | "ready" | "error";
  /** Running app version. */
  current: string;
  /** Newest version known from the feed (when found). */
  available?: string;
  /** Download progress 0..100 while status === "downloading". */
  percent?: number;
  error?: string;
  /** Strongest entitlement attached to the last check. */
  via?: "account" | "build";
}

/** Per-plan proof attached to feed requests (phase 2 entitlement). */
export interface UpdateCredentials {
  /** Supporter entitlement token (minted from the in-app Google sign-in). */
  entitlement?: string | null;
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let state: UpdateState = { status: "disabled", current: app.getVersion() };
let getWindow: () => BrowserWindow | null = () => null;
let prepareQuit: () => Promise<void> = async () => {};
let getCredentials: () => Promise<UpdateCredentials> = async () => ({});

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("nestbrain:updates:stateChanged", state);
  }
}

export function initUpdater(
  windowGetter: () => BrowserWindow | null,
  onBeforeQuit?: () => Promise<void>,
  credentialsProvider?: () => Promise<UpdateCredentials>,
): void {
  getWindow = windowGetter;
  if (onBeforeQuit) prepareQuit = onBeforeQuit;
  if (credentialsProvider) getCredentials = credentialsProvider;

  ipcMain.handle("nestbrain:updates:getState", () => state);

  if (!UPDATE_CHANNEL_KEY) {
    // Source build — no entitlement, updater stays off.
    ipcMain.handle("nestbrain:updates:check", () => state);
    ipcMain.handle("nestbrain:updates:restart", () => undefined);
    return;
  }
  if (!app.isPackaged) {
    // Dev run of an entitled tree: don't try to self-update the electron shell.
    state = { ...state, status: "dev" };
    ipcMain.handle("nestbrain:updates:check", () => state);
    ipcMain.handle("nestbrain:updates:restart", () => undefined);
    return;
  }

  // Lazy require: electron-updater is a production dep of the desktop app, but
  // keep startup resilient if the module ever fails to load.
  let autoUpdater: typeof import("electron-updater").autoUpdater;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    autoUpdater = (require("electron-updater") as typeof import("electron-updater")).autoUpdater;
  } catch (e) {
    set({ status: "error", error: `updater unavailable: ${e instanceof Error ? e.message : e}` });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // "Later" still updates on next quit
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `${UPDATE_BASE_URL.replace(/\/$/, "")}/${process.platform === "darwin" ? "mac" : "win"}`,
  });
  autoUpdater.requestHeaders = { "x-update-key": UPDATE_CHANNEL_KEY };

  // Refresh the per-plan proof before every check (phase 2): the supporter
  // entitlement (from the in-app Google sign-in). The build key always rides
  // along as the transition fallback.
  async function checkWithCredentials(): Promise<void> {
    const headers: Record<string, string> = { "x-update-key": UPDATE_CHANNEL_KEY };
    let via: UpdateState["via"] = "build";
    try {
      const creds = await getCredentials();
      if (creds.entitlement) {
        headers["x-entitlement"] = creds.entitlement;
        via = "account";
      }
    } catch {
      /* fall back to the build key alone */
    }
    autoUpdater.requestHeaders = headers;
    set({ via });
    await autoUpdater.checkForUpdates();
  }

  autoUpdater.on("checking-for-update", () => set({ status: "checking", error: undefined }));
  autoUpdater.on("update-not-available", () => set({ status: "idle", available: undefined }));
  autoUpdater.on("update-available", (info) => set({ status: "downloading", available: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => set({ status: "ready", available: info.version, percent: 100 }));
  autoUpdater.on("error", (err) => {
    // Network failures are routine (offline laptop) — record quietly, retry later.
    set({ status: "error", error: err.message });
  });

  ipcMain.handle("nestbrain:updates:check", async () => {
    try {
      await checkWithCredentials();
    } catch {
      /* state already carries the error */
    }
    return state;
  });
  ipcMain.handle("nestbrain:updates:restart", async () => {
    // Dispose the watchers BEFORE quitAndInstall: the main process's will-quit
    // handler defers quits to close them, and a deferred quit cancels
    // Squirrel's install — window gone, app stuck in the dock, still on the
    // old version. With them already closed, will-quit lets the quit through.
    try { await prepareQuit(); } catch { /* still proceed with the install */ }
    setImmediate(() => {
      autoUpdater.quitAndInstall();
      // quitAndInstall has already spawned the installer (ShipIt on macOS) by
      // the time it asks the app to quit. If a wedged native handle keeps the
      // quit from completing, exit via SIGKILL: no teardown → no fsevents
      // abort → no crash report — and the install still applies.
      setTimeout(() => {
        // Windows: SIGKILL leaves children (the Next utilityProcess is a
        // second NestBrain.exe) alive and they block the NSIS installer —
        // take the whole tree down.
        if (process.platform === "win32") {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { spawn } = require("node:child_process") as typeof import("node:child_process");
            spawn("taskkill", ["/F", "/T", "/PID", String(process.pid)], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
            }).unref();
            setTimeout(() => process.kill(process.pid, "SIGKILL"), 1500);
            return;
          } catch {
            /* fall through */
          }
        }
        process.kill(process.pid, "SIGKILL");
      }, 2500);
    });
  });

  state = { ...state, status: "idle" };
  // First check shortly after launch (let the window settle), then periodic.
  setTimeout(() => void checkWithCredentials().catch(() => {}), 15_000);
  setInterval(() => void checkWithCredentials().catch(() => {}), CHECK_EVERY_MS);
  recheck = () => void checkWithCredentials().catch(() => {});
}

// Re-evaluate credentials (and the "via" label) outside the periodic timer —
// e.g. on sign-in/sign-out, so the Updates section doesn't keep a stale
// label. Debounced: state changes come in bursts.
let recheck: (() => void) | null = null;
let recheckTimer: ReturnType<typeof setTimeout> | null = null;
export function recheckUpdates(): void {
  if (!recheck) return;
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = setTimeout(() => recheck?.(), 1_500);
}
