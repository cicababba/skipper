import { describe, expect, it } from "vitest";
import { resolveBackHref } from "./nav";

describe("resolveBackHref", () => {
  it("falls back to /inbox for null", () => {
    expect(resolveBackHref(null)).toBe("/inbox");
  });

  it("falls back to /inbox for empty string", () => {
    expect(resolveBackHref("")).toBe("/inbox");
  });

  it("rejects absolute external URLs", () => {
    expect(resolveBackHref("https://evil.com")).toBe("/inbox");
  });

  it("rejects protocol-relative URLs", () => {
    expect(resolveBackHref("//evil.com")).toBe("/inbox");
  });

  it("rejects backslash protocol-relative URLs", () => {
    expect(resolveBackHref("/\\evil.com")).toBe("/inbox");
  });

  it("rejects paths without a leading slash", () => {
    expect(resolveBackHref("inbox")).toBe("/inbox");
  });

  it("passes through an internal repo path", () => {
    expect(resolveBackHref("/repos/acme/widgets")).toBe("/repos/acme/widgets");
  });

  it("passes through an internal path with query", () => {
    expect(resolveBackHref("/inbox?repo=acme/widgets")).toBe("/inbox?repo=acme/widgets");
  });

  it("passes through /inbox", () => {
    expect(resolveBackHref("/inbox")).toBe("/inbox");
  });
});
