#!/usr/bin/env node
// Stage the standalone `uv` binary per target platform into apps/desktop/build/uv/
// (#233). electron-builder copies build/uv → resources/uv (extraResources); the
// afterPack hook then keeps only the packaged platform's binary and flattens it
// to resources/uv/uv(.exe) — the exact path main.ts resolves in production.
//
// Only mac arm64 + win x64 are staged, matching the rest of the pipeline. A
// version marker skips the re-download when the pin is unchanged.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const UV_VERSION = "0.11.32";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, "uv");

// bsdtar (macOS `tar`) reads both .tar.gz and .zip, so one extract path covers both.
const TARGETS = [
  { dir: "darwin-arm64", asset: "uv-aarch64-apple-darwin.tar.gz", bin: "uv" },
  { dir: "win32-x64", asset: "uv-x86_64-pc-windows-msvc.zip", bin: "uv.exe" },
];

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function findBin(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBin(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

for (const target of TARGETS) {
  const outDir = join(OUT_ROOT, target.dir);
  const outBin = join(outDir, target.bin);
  const marker = join(outDir, ".uv-version");
  if (
    existsSync(outBin) &&
    existsSync(marker) &&
    readFileSync(marker, "utf-8").trim() === UV_VERSION
  ) {
    console.log(`[uv] ${target.dir} already at ${UV_VERSION}`);
    continue;
  }

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${target.asset}`;
  const tmp = mkdtempSync(join(tmpdir(), "uv-"));
  try {
    const archive = join(tmp, target.asset);
    console.log(`[uv] downloading ${url}`);
    await download(url, archive);
    execFileSync("tar", ["-xf", archive, "-C", tmp]);
    const bin = findBin(tmp, target.bin);
    if (!bin) throw new Error(`${target.bin} not found in ${target.asset}`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    copyFileSync(bin, outBin);
    if (target.bin === "uv") chmodSync(outBin, 0o755);
    writeFileSync(marker, `${UV_VERSION}\n`);
    console.log(`[uv] staged ${target.dir}/${target.bin}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
