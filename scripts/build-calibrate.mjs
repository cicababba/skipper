// Bundle the calibration harness (#314) into a single CJS file: @skipper/core
// compiles to ESM with extensionless specifiers, which plain node cannot resolve,
// so the script is bundled exactly like apps/desktop/build/bundle-orchestrator.mjs.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, "calibrate-confidence.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: join(here, "dist", "calibrate-confidence.cjs"),
  logLevel: "warning",
});
console.log("[calibrate] bundled scripts/dist/calibrate-confidence.cjs");
