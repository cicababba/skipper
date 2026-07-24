/**
 * Normalize a user-typed instance URL: default https, lowercase host, strip
 * trailing slash / query / hash, keep a subpath (self-hosted under /gitlab).
 * Returns null when unparseable or not http(s).
 */
export function normalizeBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}
