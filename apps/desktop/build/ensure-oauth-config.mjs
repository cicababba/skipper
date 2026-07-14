// Make sure `apps/desktop/src/auth/oauth-config.ts` exists with the right
// credentials (one CLIENT_ID/SECRET pair per provider) before the TS
// compiler runs.
//
// Sources, merged per provider in priority order:
//
//   1. Env vars SKIPPER_GOOGLE_CLIENT_ID + SKIPPER_GOOGLE_CLIENT_SECRET
//      and/or SKIPPER_GITHUB_CLIENT_ID + SKIPPER_GITHUB_CLIENT_SECRET.
//      This is the CI / release-build path: GitHub Actions exports the
//      secrets before `pnpm desktop:build` runs.
//
//   2. `apps/desktop/.env.local` defining the same vars — the local-dev path
//      that avoids hand-editing TS sources. The file is gitignored.
//
//   3. Values already present in oauth-config.ts on disk. A legacy file with
//      the old OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET consts is recognized and
//      its values are carried over as the Google pair (the file gets
//      rewritten in the new four-const shape or the build would not compile).
//
//   4. Placeholders from oauth-config.example.ts. A provider left on its
//      placeholder shows as "unconfigured" at runtime; the others still work.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const example = join(__dirname, "../src/auth/oauth-config.example.ts");
const target = join(__dirname, "../src/auth/oauth-config.ts");
const envLocal = join(__dirname, "../.env.local");

const PLACEHOLDERS = {
  GOOGLE_OAUTH_CLIENT_ID: "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-YOUR_SECRET_HERE",
  GITHUB_OAUTH_CLIENT_ID: "YOUR_GITHUB_APP_CLIENT_ID",
  GITHUB_OAUTH_CLIENT_SECRET: "YOUR_GITHUB_APP_CLIENT_SECRET",
};

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Minimal KEY=VALUE parser instead of dotenv: this script runs on a fresh
// `pnpm install` before dev deps are guaranteed to be present.
const fileVars = existsSync(envLocal) ? parseEnvFile(readFileSync(envLocal, "utf-8")) : {};
const envVar = (name) => process.env[name] || fileVars[name];

// A pair only counts when both halves are present.
function envPair(provider) {
  const id = envVar(`SKIPPER_${provider}_CLIENT_ID`);
  const secret = envVar(`SKIPPER_${provider}_CLIENT_SECRET`);
  return id && secret ? { id, secret } : null;
}

// Values already on disk — new four-const shape, or the legacy two-const
// Google-only shape (OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET).
function existingPair(source, idConst, secretConst, legacyIdConst, legacySecretConst) {
  const grab = (name) => source.match(new RegExp(`export const ${name} = "((?:[^"\\\\]|\\\\.)*)";`))?.[1];
  const id = grab(idConst) ?? (legacyIdConst ? grab(legacyIdConst) : undefined);
  const secret = grab(secretConst) ?? (legacySecretConst ? grab(legacySecretConst) : undefined);
  return id && secret ? { id, secret } : null;
}

const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
const hasNewShape = existing.includes("GITHUB_OAUTH_CLIENT_ID");

const google =
  envPair("GOOGLE") ??
  existingPair(existing, "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET") ??
  { id: PLACEHOLDERS.GOOGLE_OAUTH_CLIENT_ID, secret: PLACEHOLDERS.GOOGLE_OAUTH_CLIENT_SECRET };
const github =
  envPair("GITHUB") ??
  existingPair(existing, "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET") ??
  { id: PLACEHOLDERS.GITHUB_OAUTH_CLIENT_ID, secret: PLACEHOLDERS.GITHUB_OAUTH_CLIENT_SECRET };

// Nothing to change: file already in the new shape and no env override.
if (hasNewShape && !envPair("GOOGLE") && !envPair("GITHUB")) {
  process.exit(0);
}

if (!existsSync(example)) {
  console.error(`[oauth] expected template at ${example} — aborting.`);
  process.exit(1);
}

// Defensive escaping for the (extremely unlikely) case a value contains a
// quote or backslash — keeps the script safe even for weird pasted secrets.
const escape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const contents = [
  "// OAuth client credentials — written by build/ensure-oauth-config.mjs.",
  "// Sources: SKIPPER_GOOGLE_CLIENT_ID / SKIPPER_GITHUB_CLIENT_ID (+ *_SECRET)",
  "// env vars or apps/desktop/.env.local, else values carried over from the",
  "// previous oauth-config.ts, else placeholders. DO NOT commit this file.",
  "",
  `export const GOOGLE_OAUTH_CLIENT_ID = "${escape(google.id)}";`,
  `export const GOOGLE_OAUTH_CLIENT_SECRET = "${escape(google.secret)}";`,
  "",
  `export const GITHUB_OAUTH_CLIENT_ID = "${escape(github.id)}";`,
  `export const GITHUB_OAUTH_CLIENT_SECRET = "${escape(github.secret)}";`,
  "",
].join("\n");
writeFileSync(target, contents, "utf-8");

const describe = (pair, name) =>
  pair.id.startsWith("YOUR_") || pair.secret.startsWith("YOUR_") || pair.secret.startsWith("GOCSPX-YOUR")
    ? `${name}: placeholder (sign-in unconfigured)`
    : `${name}: configured`;
console.log(`[oauth] wrote oauth-config.ts — ${describe(google, "google")}, ${describe(github, "github")}.`);
