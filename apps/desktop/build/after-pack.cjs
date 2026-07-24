// electron-builder afterPack hook.
// Two responsibilities:
//   1) Prune platform-specific onnxruntime-node prebuilds we don't need
//      (saves ~128 MB on Mac, ~92 MB on Windows).
//   2) On macOS, scrub extended attributes with `ditto --noextattr --noqtn`
//      so codesign doesn't reject the bundle with "resource fork, Finder
//      information, or similar detritus not allowed".
const { execSync } = require("node:child_process");
const { rmSync, renameSync, existsSync, statSync, readdirSync } = require("node:fs");
const { join, dirname } = require("node:path");

// Measure a directory tree (bytes) for nice log output.
function dirSize(p) {
  let total = 0;
  try {
    const st = statSync(p);
    if (st.isFile()) return st.size;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      total += dirSize(join(p, e.name));
    }
  } catch {
    /* ignore */
  }
  return total;
}

function rmIfExists(p, label) {
  if (!existsSync(p)) return 0;
  const size = dirSize(p);
  try {
    rmSync(p, { recursive: true, force: true });
    console.log(`  • afterPack: pruned ${label} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return size;
  } catch (err) {
    console.warn(`  • afterPack: prune ${label} failed: ${err.message}`);
    return 0;
  }
}

/**
 * onnxruntime-node ships prebuilds for darwin/linux/win32 × arm64/x64.
 * We only need the one matching the bundle we're packaging. Drop the rest.
 */
function pruneOnnxPrebuilds(platformName, cliRuntimeDir) {
  const napi = join(cliRuntimeDir, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  if (!existsSync(napi)) return 0;

  // Keep list: which "<os>/<arch>" to preserve based on target platform.
  let keep;
  if (platformName === "darwin") {
    // Mac arm64 only (we build -mac with arch=arm64).
    keep = new Set(["darwin/arm64"]);
  } else if (platformName === "win32") {
    // Win x64 only.
    keep = new Set(["win32/x64"]);
  } else if (platformName === "linux") {
    keep = new Set(["linux/x64"]);
  } else {
    console.warn(`  • afterPack: unknown platform ${platformName}, skipping onnx prune`);
    return 0;
  }

  let pruned = 0;
  // napi/ has subdirs per OS (darwin, linux, win32), each with arch subdirs.
  for (const os of readdirSync(napi, { withFileTypes: true })) {
    if (!os.isDirectory()) continue;
    const osDir = join(napi, os.name);
    for (const arch of readdirSync(osDir, { withFileTypes: true })) {
      if (!arch.isDirectory()) continue;
      const key = `${os.name}/${arch.name}`;
      if (keep.has(key)) continue;
      pruned += rmIfExists(join(osDir, arch.name), `onnxruntime-node ${key}`);
    }
  }
  return pruned;
}

/**
 * uv is staged as resources/uv/<platform>-<arch>/uv(.exe) for every target
 * (#233). Keep only the packaged platform's binary and flatten it to
 * resources/uv/uv(.exe) — the exact path main.ts resolves — dropping the rest.
 * uv is a single self-contained exe, so the NSIS no-symlink constraint is moot.
 */
function pruneUvBinaries(platformName, resourcesDir) {
  const uvRoot = join(resourcesDir, "uv");
  if (!existsSync(uvRoot)) {
    console.warn(`  • afterPack: resources/uv dir not found at ${uvRoot}`);
    return 0;
  }
  const keep =
    platformName === "darwin"
      ? { dir: "darwin-arm64", bin: "uv" }
      : platformName === "win32"
        ? { dir: "win32-x64", bin: "uv.exe" }
        : null;
  if (!keep) {
    console.warn(`  • afterPack: unknown platform ${platformName}, skipping uv prune`);
    return 0;
  }

  const staged = join(uvRoot, keep.dir, keep.bin);
  if (!existsSync(staged)) {
    console.warn(`  • afterPack: staged uv binary not found at ${staged}`);
    return 0;
  }
  let pruned = 0;
  // Move the target binary to the flat path, then delete every staging subdir.
  const flat = join(uvRoot, keep.bin);
  renameSync(staged, flat);
  for (const entry of readdirSync(uvRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    pruned += rmIfExists(join(uvRoot, entry.name), `uv ${entry.name}`);
  }
  console.log(`  • afterPack: uv flattened to resources/uv/${keep.bin}`);
  return pruned;
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;

  // Resolve the packaged cli-runtime resources dir for the current platform —
  // it now holds the onnxruntime-node prebuilds (#208).
  // On darwin: <appOutDir>/<AppName>.app/Contents/Resources/cli-runtime
  // On win32/linux: <appOutDir>/resources/cli-runtime
  let cliRuntimeDir;
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    const appName = packager.appInfo.productFilename;
    cliRuntimeDir = join(appOutDir, `${appName}.app`, "Contents", "Resources", "cli-runtime");
  } else {
    cliRuntimeDir = join(appOutDir, "resources", "cli-runtime");
  }

  // 1) Prune onnxruntime-node prebuilds for other platforms.
  if (existsSync(cliRuntimeDir)) {
    const prunedBytes = pruneOnnxPrebuilds(electronPlatformName, cliRuntimeDir);
    if (prunedBytes > 0) {
      console.log(
        `  • afterPack: freed ${(prunedBytes / 1024 / 1024).toFixed(0)} MB ` +
          `of onnxruntime-node prebuilds for other platforms`,
      );
    }
  } else {
    console.warn(`  • afterPack: resources/cli-runtime dir not found at ${cliRuntimeDir}`);
  }

  // 1b) Flatten the staged uv binaries to the single one main.ts resolves (#233).
  pruneUvBinaries(electronPlatformName, dirname(cliRuntimeDir));

  // 2) macOS xattr sanitization (pre-existing behavior).
  if (electronPlatformName === "darwin") {
    const appName = packager.appInfo.productFilename;
    const appPath = `${appOutDir}/${appName}.app`;
    const tmpPath = `${appOutDir}/.${appName}.sanitized.app`;
    try {
      execSync(`ditto --noextattr --noqtn "${appPath}" "${tmpPath}"`);
      rmSync(appPath, { recursive: true, force: true });
      renameSync(tmpPath, appPath);
      console.log(`  • afterPack: sanitized ${appName}.app (ditto strip xattrs)`);
    } catch (err) {
      console.warn(`  • afterPack: sanitize failed: ${err.message}`);
      try {
        rmSync(tmpPath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
};
