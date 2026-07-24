// Single-file CJS bundle for the `skipper` CLI.
//
// Produces dist/skipper.bundle.cjs with @skipper/core inlined and a
// shebang up front, runnable as `node dist/skipper.bundle.cjs ...` (or
// directly when chmod +x'd). The desktop builder ships this file inside
// `<App>/Contents/Resources/cli/` so installed users have a working CLI
// without cloning the repo.
//
// External deps are everything that ships native bindings or that doesn't
// bundle cleanly through esbuild (large ESM with workers, dynamic imports,
// etc.). They're resolved at runtime from a node_modules tree co-located
// with the bundle in the same dir, which copy-assets.mjs populates from
// the workspace's already-installed pnpm store.

import { build } from "esbuild";
import { mkdir, chmod, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

// Bake the package.json version into the bundle so `skipper --version`
// always reports the right thing without needing a sibling package.json
// at runtime.
const pkgJson = JSON.parse(await readFile(resolve(pkgRoot, "package.json"), "utf-8"));
const VERSION = pkgJson.version ?? "0.0.0";

const EXTERNAL = [
  // Native + heavy ESM that esbuild can't / shouldn't inline
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-common",
  "sharp",
  "pdf-parse",
  "pdfjs-dist",
  "node-pty",
  // Electron-only — never reachable from CLI but transitively referenced
  // through `@skipper/core` type-only paths; mark external just in case.
  "electron",
  // Optional/dev — never used at runtime from a CLI invocation
  "chokidar",
];

await mkdir(resolve(pkgRoot, "dist"), { recursive: true });
const outfile = resolve(pkgRoot, "dist/skipper.bundle.cjs");

const result = await build({
  entryPoints: [resolve(pkgRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  // The entry file already has its own shebang at the top of src/index.ts;
  // esbuild preserves it on the bundle output, so no banner needed.
  external: EXTERNAL,
  logLevel: "info",
  // Keep the source readable enough for stack traces.
  minify: false,
  sourcemap: false,
  // Some deps probe process.env at import time; the regex check during
  // import would otherwise crash if NODE_ENV is undefined.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __SKIPPER_CLI_VERSION__: JSON.stringify(VERSION),
  },
});

await chmod(outfile, 0o755);

// Drop a tiny manifest the desktop builder uses to know which externals to
// copy into the cli/node_modules tree alongside the bundle.
await writeFile(
  resolve(pkgRoot, "dist/runtime-externals.json"),
  JSON.stringify(EXTERNAL, null, 2),
  "utf-8",
);

console.log(`✓ bundled → ${outfile}`);
if (result.warnings.length) {
  console.log(`  ${result.warnings.length} warning(s)`);
}
