import type { RuntimeAvailability } from "@skipper/shared";

// Installed-CLI probe over IPC (#287). Outside Electron (plain browser) there is
// no main process to ask, so callers get null and offer every runtime. The
// promise is cached module-wide: up to nine RuntimeSelects mount at once and the
// answer can't change without an app restart anyway.

let cached: Promise<RuntimeAvailability | null> | null = null;

export function getRuntimeAvailability(): Promise<RuntimeAvailability | null> {
  if (typeof window === "undefined" || !window.skipper?.runtimes) return Promise.resolve(null);
  return (cached ??= window.skipper.runtimes.status().catch(() => null));
}
