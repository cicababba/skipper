// Make sure `apps/desktop/src/update-config.ts` exists before tsc runs.
//
// Auto-update is an entitlement of the OFFICIAL builds ($29 / Enterprise):
// the update channel key is injected at build time from env (CI secrets) or
// apps/desktop/.env.local — it is never committed. A source build without the
// key gets a config with an empty key, which disables the updater entirely
// (and the update server rejects keyless requests anyway).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(__dirname, "../src/update-config.ts");
const envLocal = join(__dirname, "../.env.local");

let key = process.env.SKIPPER_UPDATE_KEY;
let url = process.env.SKIPPER_UPDATE_URL;

if ((!key || !url) && existsSync(envLocal)) {
  const vars = parseEnvFile(readFileSync(envLocal, "utf-8"));
  key = key || vars.SKIPPER_UPDATE_KEY;
  url = url || vars.SKIPPER_UPDATE_URL;
}

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

const escape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const contents = [
  "// Auto-update channel config — written by build/ensure-update-config.mjs.",
  "// Empty key ⇒ updater disabled (source build). DO NOT commit this file.",
  "",
  `export const UPDATE_CHANNEL_KEY = "${escape(key ?? "")}";`,
  `export const UPDATE_BASE_URL = "${escape(url ?? "https://updates.skipper.app")}";`,
  "",
].join("\n");

writeFileSync(target, contents, "utf-8");
console.log(
  key
    ? "[updates] wrote update-config.ts with channel key (official build)."
    : "[updates] wrote update-config.ts WITHOUT key — auto-update disabled (source build).",
);
