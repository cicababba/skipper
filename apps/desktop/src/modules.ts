// Module registry — open-core seam.
//
// A "module" is a paid capability pack layered on top of the core: Dev
// (Projects), Anatomize (business document intelligence), and future ones.
// Entitlement is what's compiled into THIS build — official binaries carry
// the modules, source builds don't — so there's nothing to "unlock" by
// patching a flag. The build-time gate comes from the private dev-impl
// overlay (see dev-module.ts). License-based entitlement returns with the
// pivot's licensing model (Polar keys).

import { builtInModules } from "./dev-module";

/** Hard cap on simultaneously-loaded modules per client. */
export const MAX_ACTIVE_MODULES = 5;

/** Modules active in this build. */
export function enabledModules(): string[] {
  // Dev filter: in a dev build, NESTBRAIN_DEV_MODULES="a,b" narrows the
  // active set so a module author can test a subset. Inert in production
  // (gated on NESTBRAIN_DEV) and intersected with the built-in set, so it
  // can't conjure a module that isn't compiled in.
  const builtIn = builtInModules();
  const devFilter =
    process.env.NESTBRAIN_DEV && process.env.NESTBRAIN_DEV_MODULES
      ? process.env.NESTBRAIN_DEV_MODULES.split(",").map((s) => s.trim()).filter(Boolean)
      : null;

  const active = devFilter ? builtIn.filter((m) => devFilter.includes(m)) : builtIn;
  return active.slice(0, MAX_ACTIVE_MODULES);
}
