// Replace pnpm-managed workspace symlinks in apps/desktop/node_modules/@skipper/
// with real copies of the target packages, AND hydrate their full transitive
// dependency tree into the copy so the result is self-contained.
//
// Why this exists
// ---------------
// electron-builder validates that every file it bundles resolves under the
// app dir (apps/desktop/). pnpm workspaces give us
// apps/desktop/node_modules/@skipper/<pkg> as a symlink to packages/<pkg>,
// whose contents live outside apps/desktop/. electron-builder follows the
// link, finds the real files outside the app dir, and aborts with
// "<file> must be under apps/desktop/".
//
// Fix: deref the symlink with a real copy. Two-stage:
//
// 1. cpSync the workspace package itself (`dereference: true` so any
//    further symlinks inside, including transitive workspace deps and
//    pnpm-store-symlinked third-party deps like chokidar, become real
//    files at the destination).
//
// 2. Hydrate transitive third-party deps. cpSync brings chokidar's *own
//    package files* along, but not chokidar's siblings (readdirp,
//    anymatch, …) which live one level higher in the pnpm store. Without
//    them, `require('readdirp')` inside chokidar's index.js fails at
//    runtime in the packaged app. We walk every direct dep of the
//    workspace package, use Node's resolver to locate it on disk, copy
//    it into the workspace package's node_modules/, then recurse into
//    that dep's own dependencies — depth-first, dedup'd by name.
//
// Skips TS sources and tsbuildinfo (the packaged app only needs dist/).
//
// Run only at packaging time (wired into `package`, `package:mac`,
// `package:win`). `pnpm install` afterwards restores the symlinks by
// moving the real copies aside as `.ignored_*`, so local dev is intact.

import {
  existsSync,
  lstatSync,
  unlinkSync,
  cpSync,
  realpathSync,
  readdirSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCOPE_DIR = join(__dirname, "../node_modules/@skipper");
const require = createRequire(import.meta.url);

if (!existsSync(SCOPE_DIR)) {
  console.log("[deref] no apps/desktop/node_modules/@skipper/ to dereference; nothing to do.");
  process.exit(0);
}

function copyFilter(targetRoot) {
  return (src) => {
    const rel = src.slice(targetRoot.length).replace(/\\/g, "/");
    if (rel === "/src" || rel.startsWith("/src/")) return false;
    if (rel.endsWith(".tsbuildinfo")) return false;
    if (rel === "/tsconfig.json") return false;
    return true;
  };
}

/**
 * Resolve a third-party package's on-disk directory by asking Node's loader.
 * `fromPath` controls the lookup origin so transitive deps of a hoisted
 * package resolve against that package's own location (correct under pnpm).
 */
function resolveDepDir(depName, fromPath) {
  try {
    const pkgJsonPath = require.resolve(`${depName}/package.json`, {
      paths: [fromPath],
    });
    return dirname(pkgJsonPath);
  } catch {
    return null;
  }
}

/**
 * Copy `depName` into `dstNodeModules/<depName>/` if not already present,
 * then recurse into its `dependencies`. `resolvedFrom` is the dir we use as
 * the resolver origin for this layer.
 */
function hydrateDep(depName, resolvedFrom, dstNodeModules, copied) {
  if (copied.has(depName)) return;
  if (depName.startsWith("@skipper/")) return; // workspace deps come via cpSync of their package
  const src = resolveDepDir(depName, resolvedFrom);
  if (!src) {
    console.warn(`[deref]   ⚠ cannot resolve "${depName}" from ${resolvedFrom}; skipping`);
    return;
  }
  const dst = join(dstNodeModules, depName);
  if (!existsSync(dst)) {
    cpSync(src, dst, {
      recursive: true,
      dereference: true,
      filter: copyFilter(src),
    });
  }
  copied.add(depName);

  // Recurse into this dep's own deps. Resolve from the original source
  // location, not the destination — the pnpm store is the source of truth.
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf-8"));
  } catch {
    return;
  }
  const subDeps = Object.keys(pkg.dependencies ?? {});
  for (const sub of subDeps) {
    hydrateDep(sub, src, dstNodeModules, copied);
  }
}

let changed = 0;
for (const pkg of readdirSync(SCOPE_DIR)) {
  if (pkg.startsWith(".")) continue; // skip pnpm's `.ignored_*` graveyards
  const link = join(SCOPE_DIR, pkg);
  let st;
  try {
    st = lstatSync(link);
  } catch {
    continue;
  }
  if (!st.isSymbolicLink()) {
    console.log(`[deref] @skipper/${pkg}: already a real dir, skipping.`);
    continue;
  }
  const target = realpathSync(link);
  // unlink (not rm) so we remove the symlink itself, not its target dir.
  unlinkSync(link);
  cpSync(target, link, {
    recursive: true,
    dereference: true,
    filter: copyFilter(target),
  });
  console.log(`[deref] @skipper/${pkg}: copied ${target} → ${link}`);

  // Hydrate third-party transitive deps so chokidar's require('readdirp')
  // etc. can resolve at runtime inside the asar.
  let pkgJson;
  try {
    pkgJson = JSON.parse(readFileSync(join(link, "package.json"), "utf-8"));
  } catch {
    console.warn(`[deref]   ⚠ ${pkg}: no readable package.json post-copy; skipping hydration`);
    changed += 1;
    continue;
  }
  const directDeps = Object.keys(pkgJson.dependencies ?? {});
  if (directDeps.length === 0) {
    changed += 1;
    continue;
  }
  const dstNM = join(link, "node_modules");
  mkdirSync(dstNM, { recursive: true });
  const copied = new Set();
  // Resolve from the workspace package's *source* location — that's where
  // pnpm linked the deps in the first place.
  for (const dep of directDeps) {
    hydrateDep(dep, target, dstNM, copied);
  }
  console.log(`[deref]   hydrated ${copied.size} transitive dep(s) for @skipper/${pkg}`);
  changed += 1;
}

console.log(`[deref] done — ${changed} workspace package(s) processed.`);
