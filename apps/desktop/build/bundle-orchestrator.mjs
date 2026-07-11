// Bundle the orchestrator (src/orchestrator.ts + @nestbrain/core) into a
// single CJS file in dist/. The Electron main is CJS while @nestbrain/core
// compiles to ESM — a plain require would crash at runtime, so we bundle,
// exactly like bundle-updater.mjs does for electron-updater.
import { build } from "esbuild";

await build({
  entryPoints: ["src/orchestrator.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/orchestrator.cjs",
  external: ["electron"],
  logLevel: "warning",
});
console.log("[orchestrator] bundled dist/orchestrator.cjs");
