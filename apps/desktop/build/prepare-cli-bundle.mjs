#!/usr/bin/env node
// Drop the bundled `skipper` CLI into the standalone tree so it ships with
// the desktop app. We place the actual bundle INSIDE the Next.js standalone
// (next to apps/web/server.js) because that tree already has every runtime
// dep we externalized (@huggingface/transformers, onnxruntime-node,
// symlink-dereferenced. The shell/bat wrappers in
// apps/desktop/build/cli/ resolve to it via a relative path that survives
// the .app moving around the filesystem.

import { existsSync, cpSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const SRC = join(REPO_ROOT, "packages/cli/dist/skipper.bundle.cjs");
const DEST_DIR = join(REPO_ROOT, "apps/web/.next/standalone/apps/web");
const DEST = join(DEST_DIR, "skipper.bundle.cjs");

if (!existsSync(SRC)) {
  console.error(`[prepare-cli-bundle] missing ${SRC} — run \`pnpm --filter @skipper/cli bundle\` first.`);
  process.exit(1);
}
if (!existsSync(DEST_DIR)) {
  console.error(`[prepare-cli-bundle] missing standalone dir ${DEST_DIR} — run desktop:build first.`);
  process.exit(1);
}

cpSync(SRC, DEST);
chmodSync(DEST, 0o755);
console.log(`✓ cli bundle → web standalone (${DEST.replace(REPO_ROOT + "/", "")})`);
