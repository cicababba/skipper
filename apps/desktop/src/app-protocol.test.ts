import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { resolveStaticAsset } from "./app-protocol";

const ROOT = resolve("/web");

const FILES = new Set(
  [
    "index.html",
    "inbox.html",
    "inbox/item.html",
    "repos/repo.html",
    "_next/static/chunk-abc.js",
    "inbox.txt",
    "404.html",
  ].map((rel) => join(ROOT, ...rel.split("/"))),
);

const exists = (p: string) => FILES.has(p);

describe("resolveStaticAsset", () => {
  it("maps / to index.html", () => {
    expect(resolveStaticAsset(ROOT, "/", exists)).toBe(join(ROOT, "index.html"));
  });

  it("serves an exact static chunk", () => {
    expect(resolveStaticAsset(ROOT, "/_next/static/chunk-abc.js", exists)).toBe(
      join(ROOT, "_next", "static", "chunk-abc.js"),
    );
  });

  it("serves an RSC .txt payload exactly", () => {
    expect(resolveStaticAsset(ROOT, "/inbox.txt", exists)).toBe(join(ROOT, "inbox.txt"));
  });

  it("falls back to <path>.html for a page route", () => {
    expect(resolveStaticAsset(ROOT, "/inbox", exists)).toBe(join(ROOT, "inbox.html"));
  });

  it("falls back to <path>.html for a nested page route", () => {
    expect(resolveStaticAsset(ROOT, "/inbox/item", exists)).toBe(
      join(ROOT, "inbox", "item.html"),
    );
  });

  it("returns 404.html for an unknown path", () => {
    expect(resolveStaticAsset(ROOT, "/does-not-exist", exists)).toBe(join(ROOT, "404.html"));
  });

  it("rejects a ../ traversal", () => {
    expect(resolveStaticAsset(ROOT, "/../etc/passwd", exists)).toBeNull();
  });

  it("rejects an encoded %2e%2e traversal", () => {
    expect(resolveStaticAsset(ROOT, "/%2e%2e/%2e%2e/etc/passwd", exists)).toBeNull();
  });

  it("rejects a backslash path", () => {
    expect(resolveStaticAsset(ROOT, "/..\\..\\secret", exists)).toBeNull();
  });

  it("rejects a NUL byte", () => {
    expect(resolveStaticAsset(ROOT, "/inbox%00.html", exists)).toBeNull();
  });

  it("returns null when neither the file nor 404.html exist", () => {
    const noFallback = (p: string) => p === join(ROOT, "inbox.html");
    expect(resolveStaticAsset(ROOT, "/missing", noFallback)).toBeNull();
  });
});
