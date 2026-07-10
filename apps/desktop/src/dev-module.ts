import type { BrowserWindow, Dialog, IpcMain } from "electron";

// Open-core seam for the Dev module (Projects backend).
//
// The implementation lives in the PRIVATE nestbrain-modules repo and is
// copied into ./dev-impl/ only for official builds (CI overlay) or local dev
// (scripts/sync-modules.sh) — the directory is gitignored here. A guarded
// require keeps public source builds compiling and running as the pure
// knowledge core: no impl → no IPC backends → `builtInModules()` reports
// none and the renderer never shows the Dev surfaces.
//
// Git (#1) and terminal (#18) are NOT behind this seam anymore: they are
// product core and live in ./git.ts and ./terminal.ts. Overlaid builds may
// still carry the module's handlers — the public engines defer to them
// channel-by-channel.

export interface DevModuleDeps {
  ipcMain: IpcMain;
  dialog: Dialog;
  getMainWindow: () => BrowserWindow | null;
  getNestBrainPath: () => string | null;
  /** Run the bundled (or PATH) nestbrain CLI. */
  runNestbrainCli: (args: string[]) => void;
  /** Command the installed git hook should invoke at commit time. */
  hookCliCommand: () => string;
}

export interface DevModuleApi {
  killAllPtySessions: () => void;
}

interface DevImpl {
  register: (deps: DevModuleDeps) => DevModuleApi;
}

function loadImpl(): DevImpl | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("./dev-impl") as DevImpl;
  } catch {
    return null;
  }
}

const impl = loadImpl();

// The set of modules compiled into THIS binary. The overlay (CI or
// scripts/sync-modules.sh) writes built-in-modules.generated.ts listing the
// module folders it applied — so a new module is recognized WITHOUT editing
// any other module's code. Absent (public source build) → no modules.
function builtInList(): readonly string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("./built-in-modules.generated") as { BUILT_IN: string[] }).BUILT_IN ?? [];
  } catch {
    return [];
  }
}

export function builtInModules(): readonly string[] {
  return builtInList();
}

export function loadDevModule(deps: DevModuleDeps): DevModuleApi | null {
  return impl ? impl.register(deps) : null;
}
