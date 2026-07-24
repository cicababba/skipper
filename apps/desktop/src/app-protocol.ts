import { protocol, net } from "electron";
import { statSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Map a request pathname to a file inside the static-export web root, or null
 * when nothing should be served (#208). Pure and injected with a `fileExists`
 * predicate so it can be tested without a real filesystem.
 *
 * Resolution order mirrors Next's `output: "export"` (trailingSlash false):
 *   `/`            → index.html
 *   exact file     → served as-is (covers /_next/static/*, RSC .txt payloads)
 *   `${path}.html` → page fallback (/inbox → inbox.html, /inbox/item → …)
 *   otherwise      → 404.html, or null when even that is missing
 *
 * Traversal is refused two ways: backslashes/NULs are rejected outright, and
 * the resolved candidate must stay inside the root.
 */
export function resolveStaticAsset(
  root: string,
  pathname: string,
  fileExists: (absPath: string) => boolean,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  const rootResolved = resolve(root);

  if (decoded === "" || decoded === "/") {
    const index = join(rootResolved, "index.html");
    return fileExists(index) ? index : null;
  }

  const candidate = resolve(
    rootResolved,
    `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`,
  );
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return null;
  }

  if (fileExists(candidate)) return candidate;

  const asHtml = `${candidate}.html`;
  if (fileExists(asHtml)) return asHtml;

  const notFound = join(rootResolved, "404.html");
  return fileExists(notFound) ? notFound : null;
}

function isFile(absPath: string): boolean {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/** Serve the static export over `app://skipper/...`. net.fetch on a file URL
 *  gives us correct MIME types for free. */
export function registerAppProtocol(webRoot: string): void {
  protocol.handle("app", (request) => {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const { pathname } = new URL(request.url);
    const filePath = resolveStaticAsset(webRoot, pathname, isFile);
    if (!filePath) {
      return new Response("Not Found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}
