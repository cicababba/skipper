// Embedder host for the Electron main (#255). @skipper/core keeps the
// transformers dependency behind registerTransformersLoader so nothing imports
// @huggingface/transformers statically — esbuild would try to inline the native
// package into the orchestrator bundle. Packaged, the package sits in the
// co-located node_modules next to the CLI bundle (resources/cli-runtime); in dev
// it resolves from the workspace root.
//
// This must be called from inside the orchestrator bundle: @skipper/core is
// bundled into orchestrator.cjs, so registering from main.ts would write the
// loader onto a different copy of the module and silently do nothing.

import { createRequire } from "node:module";
import { registerTransformersLoader } from "@skipper/core";

export interface EmbedderHostOptions {
  /** Packaged CLI bundle path — its node_modules holds the native deps. */
  cliBundlePath: string | null;
  /** Model cache shared with the CLI so the download happens once. */
  hfCacheDir: string;
}

export function registerEmbedderHost(options: EmbedderHostOptions): void {
  const req = createRequire(options.cliBundlePath ?? __filename);
  registerTransformersLoader(() => {
    const t = req("@huggingface/transformers");
    if (t?.env) t.env.cacheDir = options.hfCacheDir;
    return t;
  });
}
