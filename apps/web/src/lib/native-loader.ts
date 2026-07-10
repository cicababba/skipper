// Runtime loader for native/CJS packages that must bypass Turbopack bundling.
// Turbopack aggressively analyzes require() and import() calls to trace
// dependencies, even for the values stored in `createRequire(...)`. To
// completely hide the require calls from static analysis we build the loader
// functions with `new Function(...)` — Turbopack treats the body as an opaque
// string so the package names never enter its dependency graph.
//
// Required for:
//   - @huggingface/transformers: .mjs entry has an ESM↔CJS interop issue
//     with onnxruntime-common; .cjs entry works via require().
import { createRequire } from "node:module";
import { registerTransformersLoader } from "@nestbrain/core";

const nodeRequire = createRequire(import.meta.url);

// Build loader functions via `new Function` so Turbopack can't statically
// detect the require targets. The bodies are plain strings to the analyzer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadTransformersRaw: () => any = new Function(
  "req",
  "return function(){return req('@hug' + 'gingface/transformers');}",
)(nodeRequire);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadTransformers: () => any = () => {
  const t = loadTransformersRaw();
  // Persist the model cache in the app's userData (NESTBRAIN_HF_CACHE, set by
  // the Electron main). The library default writes inside node_modules — in a
  // packaged install that's the app bundle: not reliably writable (Windows)
  // and wiped on every update, forcing a re-download from huggingface.co.
  const cacheDir = process.env.NESTBRAIN_HF_CACHE;
  if (cacheDir && t?.env) t.env.cacheDir = cacheDir;
  return t;
};

let registered = false;

export function ensureNativeLoadersRegistered(): void {
  if (registered) return;
  registered = true;
  registerTransformersLoader(loadTransformers);
}
