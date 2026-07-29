// Static export can't serve runtime-id dynamic routes, so item and repo pages
// carry their identity in query params (#208). These helpers build the hrefs;
// URLSearchParams encodes each value.

export function itemHref(id: string, from?: string | null): string {
  const params = new URLSearchParams({ id });
  if (from) params.set("from", from);
  return `/inbox/item?${params.toString()}`;
}

export function repoHref(
  repo: { owner: string; name: string },
  opts?: { tab?: "memory"; mq?: string },
): string {
  const params = new URLSearchParams({ owner: repo.owner, name: repo.name });
  if (opts?.tab) params.set("tab", opts.tab);
  if (opts?.mq) params.set("mq", opts.mq);
  return `/repos/repo?${params.toString()}`;
}

export function repoSettingsHref(repo: { owner: string; name: string }): string {
  const params = new URLSearchParams({ owner: repo.owner, name: repo.name });
  return `/repos/repo/settings?${params.toString()}`;
}

export function composeHref(repo: { owner: string; name: string }, mode?: "quick"): string {
  const params = new URLSearchParams({ owner: repo.owner, name: repo.name });
  if (mode) params.set("mode", mode);
  return `/compose?${params.toString()}`;
}

export function resolveBackHref(from: string | null): string {
  // Browsers treat `/\evil.com` like protocol-relative `//evil.com`, so guard both.
  if (from && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/\\")) {
    return from;
  }
  return "/inbox";
}
