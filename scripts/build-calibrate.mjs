// Bundle the calibration harness (#314) into a single CJS file: @skipper/core
// compiles to ESM with extensionless specifiers, which plain node cannot resolve,
// so the script is bundled exactly like apps/desktop/build/bundle-orchestrator.mjs.
// The workspace packages are aliased to their sources: resolving them through
// package.json "main" would bundle whatever dist/ happens to hold, so a report
// could come out of arbitrarily old code with no signal (#334).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function gitProvenance() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf-8",
    });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: "unknown", dirty: false };
  }
}

const code = gitProvenance();

await build({
  entryPoints: [join(here, "calibrate-confidence.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  alias: {
    "@skipper/core": join(root, "packages", "core", "src", "index.ts"),
    "@skipper/shared": join(root, "packages", "shared", "src", "index.ts"),
  },
  define: {
    __CALIBRATE_CODE_SHA__: JSON.stringify(code.sha),
    __CALIBRATE_CODE_DIRTY__: JSON.stringify(code.dirty),
  },
  outfile: join(here, "dist", "calibrate-confidence.cjs"),
  logLevel: "warning",
});
console.log(
  `[calibrate] bundled scripts/dist/calibrate-confidence.cjs from ${code.sha}${code.dirty ? " (dirty)" : ""}`,
);
