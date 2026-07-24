#!/usr/bin/env node
// Assemble apps/desktop/build/cli-runtime/ — the packaged home of the `skipper`
// CLI bundle and the native embedder deps it createRequire()s at runtime
// (#208). This replaces the old standalone-tree co-location: the bundle used to
// live inside the Next.js standalone output next to its externalized
// node_modules; with the server gone (static export), it needs its own tree.
//
// The result is copied to resources/cli-runtime by electron-builder and must be
// ZERO-SYMLINK: the Windows NSIS installer silently drops symlinks, so every
// dep is copied as real files (cpSync dereference:true) and the script asserts
// no symlink survives before exiting.
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  lstatSync,
  chmodSync,
  cpSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const APPS_WEB_ROOT = join(REPO_ROOT, "apps/web");
const REAL_STORE = join(REPO_ROOT, "node_modules/.pnpm");

const CLI_BUNDLE = join(REPO_ROOT, "packages/cli/dist/skipper.bundle.cjs");
const OUT_DIR = join(__dirname, "cli-runtime");
const OUT_NM = join(OUT_DIR, "node_modules");

// Native embedder deps the CLI bundle require()s at runtime.
const TOP_LEVEL_PACKAGES = [
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-common",
  "sharp",
];

// === Step 1: fresh output dir + the CLI bundle ===
if (!existsSync(CLI_BUNDLE)) {
  console.error(
    `[prepare-cli-runtime] missing ${CLI_BUNDLE} — run \`pnpm --filter @skipper/cli build\` first.`,
  );
  process.exit(1);
}
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_NM, { recursive: true });
cpSync(CLI_BUNDLE, join(OUT_DIR, "skipper.bundle.cjs"));
chmodSync(join(OUT_DIR, "skipper.bundle.cjs"), 0o755);
console.log("✓ skipper.bundle.cjs");

// === Step 2: copy the native packages + their pnpm-store siblings ===
// require.resolve follows symlinks, so each root lands in the real .pnpm store;
// cpSync(dereference:true) then produces flat real files with no symlinks.
const require = createRequire(join(APPS_WEB_ROOT, "package.json"));

function packageRoot(pkg) {
  const searchPaths = [APPS_WEB_ROOT, join(REPO_ROOT, "packages/core"), REPO_ROOT];
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`, { paths: searchPaths });
    return dirname(pkgJson);
  } catch {
    /* fall through */
  }
  try {
    const entry = require.resolve(pkg, { paths: searchPaths });
    let dir = dirname(entry);
    while (dir !== dirname(dir)) {
      const pj = join(dir, "package.json");
      if (existsSync(pj)) {
        try {
          const content = JSON.parse(readFileSync(pj, "utf-8"));
          if (content.name === pkg) return dir;
        } catch {
          /* ignore */
        }
      }
      dir = dirname(dir);
    }
  } catch (err) {
    console.warn(`[warn] cannot resolve ${pkg}:`, err.message);
  }
  return null;
}

const placed = new Set();

function copyToTopLevel(pkgName, src) {
  if (placed.has(pkgName)) return false;
  const dst = join(OUT_NM, pkgName);
  mkdirSync(dirname(dst), { recursive: true });
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, dereference: true });
  placed.add(pkgName);
  return true;
}

/**
 * Enumerate a package's flat siblings inside its `.pnpm/<pkg>@<ver>/node_modules`
 * bucket and copy each to the runtime top-level. This is how pnpm lays out
 * runtime deps (e.g. detect-libc next to sharp) — without it, sharp/onnx can't
 * resolve their own dependencies.
 */
function copySiblingDeps(realPkgDir, pkgName) {
  const storeNm = pkgName.startsWith("@")
    ? dirname(dirname(realPkgDir))
    : dirname(realPkgDir);
  if (!existsSync(storeNm)) return 0;
  let copied = 0;
  for (const entry of readdirSync(storeNm, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(storeNm, entry.name);
    if (entry.name.startsWith("@")) {
      try {
        for (const sub of readdirSync(entryPath, { withFileTypes: true })) {
          if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
          const fullName = `${entry.name}/${sub.name}`;
          if (fullName === pkgName) continue;
          if (copyToTopLevel(fullName, join(entryPath, sub.name))) copied++;
        }
      } catch {
        /* ignore */
      }
    } else {
      if (entry.name === pkgName) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (copyToTopLevel(entry.name, entryPath)) copied++;
    }
  }
  return copied;
}

for (const pkg of TOP_LEVEL_PACKAGES) {
  const root = packageRoot(pkg);
  if (!root) continue;
  copyToTopLevel(pkg, root);
  console.log(`✓ node_modules/${pkg}`);
  const siblings = copySiblingDeps(root, pkg);
  if (siblings > 0) console.log(`  └─ +${siblings} sibling dep(s) from .pnpm store`);
}

// sharp's platform libvips packages resolve their own siblings (detect-libc)
// against their own .pnpm bucket — harvest those too.
const EXTRA_STORE_PREFIXES = ["@img+sharp-", "@img+sharp-libvips-"];
if (existsSync(REAL_STORE)) {
  for (const entry of readdirSync(REAL_STORE)) {
    if (!EXTRA_STORE_PREFIXES.some((p) => entry.startsWith(p))) continue;
    const storeNm = join(REAL_STORE, entry, "node_modules");
    if (!existsSync(storeNm)) continue;
    for (const dep of readdirSync(storeNm, { withFileTypes: true })) {
      if (dep.name.startsWith(".")) continue;
      if (dep.name.startsWith("@")) {
        try {
          for (const sub of readdirSync(join(storeNm, dep.name), { withFileTypes: true })) {
            if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
            copyToTopLevel(`${dep.name}/${sub.name}`, join(storeNm, dep.name, sub.name));
          }
        } catch {
          /* ignore */
        }
      } else if (dep.isDirectory() || dep.isSymbolicLink()) {
        copyToTopLevel(dep.name, join(storeNm, dep.name));
      }
    }
  }
}
console.log(`✓ total packages at top-level: ${placed.size}`);

// === Step 3: prune bloat (platform-agnostic) ===
// Target-specific onnxruntime-node prebuilds are pruned later by after-pack.cjs
// once the packaging platform is known.
const PRUNE_PATHS = [
  "onnxruntime-web",
  "@huggingface/transformers/dist/transformers.web.js",
  "@huggingface/transformers/dist/transformers.web.min.js",
  "@huggingface/transformers/dist/transformers.js",
  "@huggingface/transformers/dist/transformers.min.js",
  "@huggingface/transformers/dist/transformers.node.mjs",
  "@huggingface/transformers/dist/transformers.node.min.cjs",
  "@huggingface/transformers/dist/transformers.node.min.mjs",
  "@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs",
  "@huggingface/transformers/src",
  "@huggingface/transformers/types",
  "@huggingface/transformers/README.md",
];

function dirSize(p) {
  let total = 0;
  try {
    const stat = lstatSync(p);
    if (stat.isFile() || stat.isSymbolicLink()) return stat.size || 0;
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      total += dirSize(join(p, entry.name));
    }
  } catch {
    /* ignore */
  }
  return total;
}

let prunedBytes = 0;
for (const rel of PRUNE_PATHS) {
  const target = join(OUT_NM, rel);
  if (!existsSync(target)) continue;
  const size = dirSize(target);
  try {
    rmSync(target, { recursive: true, force: true });
    prunedBytes += size;
    console.log(`✂  pruned ${rel}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    console.warn(`[warn] prune failed for ${rel}: ${err.message}`);
  }
}

// === Step 4: node-pty spawn-helper +x in the real store ===
// pnpm strips the +x bit on extraction; node-pty ships to the packaged app via
// electron-builder `files:` from the real store, so fix it there.
const nodePtyPrebuilds = join(
  REAL_STORE,
  "node-pty@1.1.0/node_modules/node-pty/prebuilds",
);
if (existsSync(nodePtyPrebuilds)) {
  for (const platDir of readdirSync(nodePtyPrebuilds)) {
    const helper = join(nodePtyPrebuilds, platDir, "spawn-helper");
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
        console.log(`✓ chmod +x ${platDir}/spawn-helper`);
      } catch (err) {
        console.warn(`[warn] chmod spawn-helper failed: ${err.message}`);
      }
    }
  }
}

// === Step 5: zero-symlink assertion (Windows NSIS invariant) ===
function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      console.error(`[prepare-cli-runtime] FATAL: symlink survived at ${p}`);
      process.exit(1);
    }
    if (entry.isDirectory()) assertNoSymlinks(p);
  }
}
assertNoSymlinks(OUT_DIR);

console.log(
  `\ncli-runtime prepared: ${placed.size} packages, ` +
    `pruned ${(prunedBytes / 1024 / 1024).toFixed(0)} MB, zero symlinks.`,
);
