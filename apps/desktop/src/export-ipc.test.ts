import { describe, expect, it, vi } from "vitest";
import { registerExportHandlers, type ExportIpcDeps } from "./export-ipc";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

interface SetupOptions {
  window?: unknown;
  dialogResult?: { canceled: boolean; filePath?: string };
  dialogThrows?: boolean;
  writeThrows?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  };
  const showSaveDialog = vi.fn(async () => {
    if (opts.dialogThrows) throw new Error("dialog boom");
    return opts.dialogResult ?? { canceled: false, filePath: "/out/file.md" };
  });
  const writeFile = vi.fn(async () => {
    if (opts.writeThrows) throw new Error("disk full");
  });
  const deps = {
    ipcMain,
    getMainWindow: () => ("window" in opts ? opts.window : {}),
    showSaveDialog,
    writeFile,
  } as unknown as ExportIpcDeps;
  registerExportHandlers(deps);
  const handler = handlers.get("skipper:export:saveMarkdown");
  if (!handler) throw new Error("handler not registered");
  return { handler, showSaveDialog, writeFile };
}

describe("registerExportHandlers", () => {
  it("fails when there is no window and never opens the dialog", async () => {
    const { handler, showSaveDialog } = setup({ window: null });
    const res = await handler(null, "acme-42-plan.md", "# Plan");
    expect(res).toEqual({ ok: false, error: "no window" });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("reports cancellation without writing when the dialog is dismissed", async () => {
    const { handler, writeFile } = setup({ dialogResult: { canceled: true } });
    const res = await handler(null, "acme-42-plan.md", "# Plan");
    expect(res).toEqual({ ok: true, canceled: true });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("treats an empty filePath as cancellation", async () => {
    const { handler, writeFile } = setup({ dialogResult: { canceled: false } });
    const res = await handler(null, "acme-42-plan.md", "# Plan");
    expect(res).toEqual({ ok: true, canceled: true });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes the content to the chosen path on success", async () => {
    const { handler, writeFile } = setup({
      dialogResult: { canceled: false, filePath: "/chosen/out.md" },
    });
    const res = await handler(null, "acme-42-plan.md", "# Plan\n\nbody");
    expect(res).toEqual({ ok: true });
    expect(writeFile).toHaveBeenCalledWith("/chosen/out.md", "# Plan\n\nbody");
  });

  it("returns the error when the write throws", async () => {
    const { handler } = setup({
      dialogResult: { canceled: false, filePath: "/chosen/out.md" },
      writeThrows: true,
    });
    const res = await handler(null, "acme-42-plan.md", "# Plan");
    expect(res).toEqual({ ok: false, error: "disk full" });
  });
});
