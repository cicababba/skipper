#!/usr/bin/env node
// After `next build` with output: standalone, Next.js traces imports and
// copies only the files it detected. For native-binding packages (e.g.
// onnxruntime-node, sharp) this misses sibling assets
// like .dylib, .so, worker files, etc. We fix two things:
//
// 1) Create top-level symlinks in standalone/node_modules/<pkg> → real pnpm
//    store location, so Node's resolver can find externalized packages.
// 2) Replace the (partial) NFT-copied package directories inside
//    standalone/node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg> with
//    symlinks to the real pnpm package dirs, so dlopen of .node files can
//    find their sibling .dylib/.so files.
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
  lstatSync,
  chmodSync,
  cpSync,
  realpathSync,
  readlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// We always do real file copies (not symlinks) so the prepared standalone
// is self-contained and safe both for dev iteration AND for electron-builder
// packaging. Surgical sync only adds the few native files NFT missed
// (.node/.dylib/.so/.wasm/.dll), so the cost is negligible and idempotent.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const STANDALONE_ROOT = join(REPO_ROOT, "apps/web/.next/standalone/node_modules");
const APPS_WEB_ROOT = join(REPO_ROOT, "apps/web");
const REAL_STORE = join(REPO_ROOT, "node_modules/.pnpm");
const STANDALONE_STORE = join(STANDALONE_ROOT, ".pnpm");

if (!existsSync(STANDALONE_ROOT)) {
  console.error("Standalone node_modules not found at:", STANDALONE_ROOT);
  process.exit(1);
}

// Top-level packages we want resolvable by Node require from standalone
const TOP_LEVEL_PACKAGES = [
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-common",
  "sharp",
];

// Packages with native binaries that need full pnpm store dir replacement
// Format: { nameInStore: "onnxruntime-node@1.24.3", nameInNm: "onnxruntime-node" }
const NATIVE_PACKAGES_TO_REPLACE = [];

// Discover which .pnpm entries exist in the standalone copy and target them
if (existsSync(STANDALONE_STORE)) {
  for (const entry of readdirSync(STANDALONE_STORE)) {
    // Match packages that commonly ship native bins
    if (
      entry.startsWith("onnxruntime-node@") ||
      entry.startsWith("onnxruntime-web@") ||
      entry.startsWith("sharp@") ||
      entry.startsWith("@img+sharp-")
    ) {
      // Determine the actual package name inside .pnpm/<entry>/node_modules/
      const nmDir = join(STANDALONE_STORE, entry, "node_modules");
      if (!existsSync(nmDir)) continue;
      for (const subEntry of readdirSync(nmDir)) {
        if (subEntry.startsWith("@")) {
          // scoped: go one deeper
          const scopedDir = join(nmDir, subEntry);
          try {
            for (const sub2 of readdirSync(scopedDir)) {
              NATIVE_PACKAGES_TO_REPLACE.push({
                storeDir: entry,
                pkgName: `${subEntry}/${sub2}`,
              });
            }
          } catch { /* ignore */ }
        } else if (!subEntry.startsWith(".")) {
          NATIVE_PACKAGES_TO_REPLACE.push({
            storeDir: entry,
            pkgName: subEntry,
          });
        }
      }
    }
  }
}

function forceRemove(p) {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || st.isFile()) {
      rmSync(p, { force: true });
    } else {
      rmSync(p, { recursive: true, force: true });
    }
  } catch { /* already gone */ }
}

function makeSymlink(linkPath, target) {
  // Ensure parent dir exists
  mkdirSync(dirname(linkPath), { recursive: true });
  forceRemove(linkPath);
  symlinkSync(target, linkPath, "dir");
}

function recursiveCopy(linkPath, target) {
  mkdirSync(dirname(linkPath), { recursive: true });
  forceRemove(linkPath);
  // Recursive copy, dereferencing nested symlinks so the result is
  // self-contained and safe to put inside a packaged .app bundle.
  cpSync(target, linkPath, { recursive: true, dereference: true });
}

// Surgical native-file sync: copy only the NATIVE binary files (.node,
// .dylib, .so, .wasm) from the real pnpm store into the standalone's
// partial package dir, WITHOUT replacing whole packages. This avoids the
// duplication bloat that wholesale `cpSync(dereference:true)` causes when
// a package directory contains relative symlinks to sibling deps.
const NATIVE_EXTS = new Set([".node", ".dylib", ".so", ".wasm", ".dll"]);
function hasNativeExt(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return NATIVE_EXTS.has(name.slice(dot).toLowerCase());
}
function syncNativeFiles(realDir, standaloneDir) {
  if (!existsSync(realDir)) return 0;
  let synced = 0;
  for (const entry of readdirSync(realDir, { withFileTypes: true })) {
    const realChild = join(realDir, entry.name);
    const standaloneChild = join(standaloneDir, entry.name);
    if (entry.isDirectory()) {
      if (!existsSync(standaloneChild)) {
        mkdirSync(standaloneChild, { recursive: true });
      }
      synced += syncNativeFiles(realChild, standaloneChild);
    } else if (entry.isFile() && hasNativeExt(entry.name)) {
      if (!existsSync(standaloneChild)) {
        mkdirSync(dirname(standaloneChild), { recursive: true });
        cpSync(realChild, standaloneChild);
        synced++;
      }
    }
  }
  return synced;
}

// === Step 1: SURGICAL native-file hydration ===
// For each native package, copy ONLY the missing native files (.node,
// .dylib, .so, .wasm, .dll) into the NFT-traced partial dir. Leaves all
// relative sibling symlinks intact, so transitive deps aren't duplicated.
let surgicalFiles = 0;
for (const { storeDir, pkgName } of NATIVE_PACKAGES_TO_REPLACE) {
  const standalonePkgPath = join(STANDALONE_STORE, storeDir, "node_modules", pkgName);
  const realPkgPath = join(REAL_STORE, storeDir, "node_modules", pkgName);
  if (!existsSync(realPkgPath)) {
    console.warn(`[warn] real package missing: ${realPkgPath}`);
    continue;
  }
  const added = syncNativeFiles(realPkgPath, standalonePkgPath);
  if (added > 0) {
    console.log(`+ hydrated ${added} native file(s) in .pnpm/${storeDir}/node_modules/${pkgName}`);
    surgicalFiles += added;
  }
}

// === Step 2: create top-level symlinks for externalized packages ===
const require = createRequire(join(APPS_WEB_ROOT, "package.json"));

function packageRoot(pkg) {
  const searchPaths = [APPS_WEB_ROOT, join(REPO_ROOT, "packages/core"), REPO_ROOT];
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`, { paths: searchPaths });
    return dirname(pkgJson);
  } catch { /* fall through */ }
  try {
    const entry = require.resolve(pkg, { paths: searchPaths });
    let dir = dirname(entry);
    while (dir !== dirname(dir)) {
      const pj = join(dir, "package.json");
      if (existsSync(pj)) {
        try {
          const content = JSON.parse(readFileSync(pj, "utf-8"));
          if (content.name === pkg) return dir;
        } catch { /* ignore */ }
      }
      dir = dirname(dir);
    }
  } catch (err) {
    console.warn(`[warn] cannot resolve ${pkg}:`, err.message);
  }
  return null;
}

// Track which packages we've already copied to top-level (dedup)
const placedAtTopLevel = new Set();

function copyToTopLevel(pkgName, src) {
  if (placedAtTopLevel.has(pkgName)) return false;
  const dst = join(STANDALONE_ROOT, pkgName);
  recursiveCopy(dst, src);
  placedAtTopLevel.add(pkgName);
  return true;
}

/**
 * Given the real path of a package inside `.pnpm/<pkg>@<ver>/node_modules/<pkg>`,
 * enumerate its siblings in the same `.pnpm` node_modules dir and copy each one
 * to the standalone top-level. This is how pnpm lays out runtime deps: they
 * live as flat siblings next to the main package in the same .pnpm bucket.
 * Without this, `sharp` can't find `detect-libc`, etc.
 */
function copySiblingDeps(realPkgDir, pkgName) {
  // realPkgDir = .../node_modules/.pnpm/<entry>/node_modules/<pkgName>
  // Walk up to get the store node_modules dir
  let storeNm;
  if (pkgName.startsWith("@")) {
    // scoped: .../<pkgName is scope/name> → parent is the scope dir, parent of parent is store nm
    storeNm = dirname(dirname(realPkgDir));
  } else {
    storeNm = dirname(realPkgDir);
  }
  if (!existsSync(storeNm)) return 0;
  let copied = 0;
  for (const entry of readdirSync(storeNm, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(storeNm, entry.name);
    if (entry.name.startsWith("@")) {
      // scoped scope dir: enumerate sub-packages
      try {
        for (const sub of readdirSync(entryPath, { withFileTypes: true })) {
          if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
          const fullName = `${entry.name}/${sub.name}`;
          if (fullName === pkgName) continue;
          if (copyToTopLevel(fullName, join(entryPath, sub.name))) copied++;
        }
      } catch { /* ignore */ }
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
  console.log(`✓ node_modules/${pkg} → ${root}`);
  // Also copy the package's pnpm sibling deps (detect-libc next to sharp, etc)
  const siblings = copySiblingDeps(root, pkg);
  if (siblings > 0) {
    console.log(`  └─ +${siblings} sibling dep(s) from .pnpm store`);
  }
}

// Additional pass: for known-problematic native sub-packages (sharp's platform
// libvips packages, onnxruntime web/node variants) also harvest their .pnpm
// store siblings. sharp-libvips.js does `require('detect-libc')` from inside
// @img/sharp-libvips-darwin-arm64 — that require resolves against
// @img+sharp-libvips-darwin-arm64@<ver>/node_modules/, which has its own
// sibling deps we must surface at the top level.
const EXTRA_STORE_PREFIXES = [
  "@img+sharp-",
  "@img+sharp-libvips-",
];
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
        } catch { /* ignore */ }
      } else if (dep.isDirectory() || dep.isSymbolicLink()) {
        copyToTopLevel(dep.name, join(storeNm, dep.name));
      }
    }
  }
}
console.log(`✓ total packages at top-level: ${placedAtTopLevel.size}`);

// === Step 3: ensure node-pty spawn-helper is executable ===
// pnpm strips the +x bit during extraction, which causes posix_spawnp to fail
// at runtime when node-pty tries to launch the shell.
const nodePtyPrebuilds = join(
  REPO_ROOT,
  "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds",
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

// === Step 4: Remove dangling symlinks in .pnpm/node_modules/ ===
// Next.js's NFT output sometimes contains symlink shims at
// standalone/node_modules/.pnpm/node_modules/<pkg> that point at package
// versions that were never copied into the standalone tree (e.g.
// semver → ../semver@6.3.1/... when only semver@7.7.4 was copied).
// These are harmless in dev (nothing stats them) but crash electron-builder's
// code-signing pass with ENOENT. Scrub them.
const pnpmNmDir = join(STANDALONE_STORE, "node_modules");
let danglingRemoved = 0;
function scrubDangling(dir, depth = 0) {
  if (depth > 3 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        statSync(p); // throws on dangling
      } catch {
        try {
          rmSync(p, { force: true });
          danglingRemoved++;
        } catch {
          /* ignore */
        }
      }
    } else if (entry.isDirectory()) {
      scrubDangling(p, depth + 1);
    }
  }
}
scrubDangling(pnpmNmDir);
if (danglingRemoved > 0) {
  console.log(`✗ removed ${danglingRemoved} dangling symlink(s) in .pnpm/node_modules/`);
}

// === Step 5: PRUNE bloat (platform-agnostic) ===
// These paths are always safe to drop regardless of target platform:
// we never use the browser/ESM/min/types variants of heavy packages at
// runtime. Target-specific native prebuilds (onnxruntime-node/bin/napi-v6/<os>)
// are pruned later by after-pack.cjs once we know whether we're packaging
// for Mac or Windows.
const PRUNE_PATHS = [
  // onnxruntime-web: 133 MB of browser-targeted ONNX runtime we never touch.
  // We use onnxruntime-node for all inference; transformers.node.cjs imports
  // onnxruntime-node directly, not -web.
  "onnxruntime-web",

  // @huggingface/transformers: keep only transformers.node.cjs (main entry
  // consumed by our native loader) and its siblings. Drop browser / ESM /
  // minified variants and development assets.
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

let prunedBytes = 0;
function dirSize(p) {
  let total = 0;
  try {
    const stat = lstatSync(p);
    if (stat.isFile() || stat.isSymbolicLink()) return stat.size || 0;
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      total += dirSize(join(p, entry.name));
    }
  } catch { /* ignore */ }
  return total;
}

for (const rel of PRUNE_PATHS) {
  const target = join(STANDALONE_ROOT, rel);
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

// === Step 6: DEREFERENCE every remaining symlink in the standalone tree ===
// pnpm's .pnpm/ store is held together by relative symlinks
// (e.g. .pnpm/next@.../node_modules/@swc/helpers → ../../../@swc+helpers@.../...).
// On macOS this is fine because DMG preserves symlinks.  On Windows the NSIS
// installer CANNOT create symlinks — they are silently lost during extraction,
// producing MODULE_NOT_FOUND at runtime for @swc/helpers, react, styled-jsx,
// and every other pnpm-hoisted transitive dependency.
//
// Fix: walk the entire standalone tree AFTER all other steps and replace every
// symlink with a real copy of its target.  This makes the tree fully
// self-contained with zero symlinks — portable to any OS and any installer.
const STANDALONE_BASE = join(REPO_ROOT, "apps/web/.next/standalone");
let dereferencedCount = 0;

function derefAllSymlinks(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        // Resolve the real path the symlink points to
        const realTarget = realpathSync(p);
        const targetStat = statSync(realTarget);

        // Remove the symlink
        rmSync(p, { force: true });

        if (targetStat.isDirectory()) {
          cpSync(realTarget, p, { recursive: true, dereference: true });
        } else {
          cpSync(realTarget, p);
        }
        dereferencedCount++;
      } catch {
        // Dangling or broken — just remove it
        try {
          rmSync(p, { force: true });
          dereferencedCount++;
        } catch { /* ignore */ }
      }
    } else if (entry.isDirectory() && entry.name !== ".git") {
      derefAllSymlinks(p);
    }
  }
}

console.log("Dereferencing all symlinks in standalone tree...");
derefAllSymlinks(STANDALONE_BASE);
console.log(`✓ dereferenced ${dereferencedCount} symlink(s)`);

// === Step 7: Promote hoisted packages to apps/web/node_modules/ ===
// pnpm's hoisted packages live at `node_modules/.pnpm/node_modules/<pkg>`.
// After dereferencing, packages like `next` at `apps/web/node_modules/next`
// are real directories — Node.js no longer follows the symlink into the
// .pnpm store to find sibling deps (@swc/helpers, react, styled-jsx, etc.).
// Fix: copy every package from the .pnpm/node_modules/ hoisted dir into
// apps/web/node_modules/ so require() from inside next/dist/... finds them.
const APP_WEB_NM = join(STANDALONE_BASE, "apps/web/node_modules");
const HOISTED_NM = join(STANDALONE_STORE, "node_modules");
let promotedCount = 0;

function promoteHoistedPackage(name, src) {
  const dest = join(APP_WEB_NM, name);
  if (existsSync(dest)) return; // already there (e.g. next itself)
  try {
    const realSrc = realpathSync(src);
    cpSync(realSrc, dest, { recursive: true, dereference: true });
    promotedCount++;
  } catch {
    // If realpath fails the target is dangling — skip it
  }
}

if (existsSync(HOISTED_NM)) {
  for (const entry of readdirSync(HOISTED_NM, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(HOISTED_NM, entry.name);
    if (entry.name.startsWith("@")) {
      // Scoped package: enumerate sub-entries
      try {
        for (const sub of readdirSync(entryPath, { withFileTypes: true })) {
          promoteHoistedPackage(`${entry.name}/${sub.name}`, join(entryPath, sub.name));
        }
      } catch { /* ignore */ }
    } else {
      promoteHoistedPackage(entry.name, entryPath);
    }
  }
}
if (promotedCount > 0) {
  console.log(`✓ promoted ${promotedCount} hoisted package(s) into apps/web/node_modules/`);
}

console.log(
  `\nStandalone modules prepared: ${surgicalFiles} native files hydrated, ` +
  `${danglingRemoved} dangling scrubbed, top-level entries in place. ` +
  `Pruned ${(prunedBytes / 1024 / 1024).toFixed(0)} MB of unused variants. ` +
  `${dereferencedCount} symlinks dereferenced.`,
);
