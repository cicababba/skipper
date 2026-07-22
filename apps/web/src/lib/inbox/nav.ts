export function resolveBackHref(from: string | null): string {
  // Browsers treat `/\evil.com` like protocol-relative `//evil.com`, so guard both.
  if (from && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/\\")) {
    return from;
  }
  return "/inbox";
}
