import { describe, it, expect } from "vitest";
import { normalizeBaseUrl } from "../src/base-url";

describe("normalizeBaseUrl", () => {
  it("defaults to https when no scheme is given", () => {
    expect(normalizeBaseUrl("git.corp.example")).toBe("https://git.corp.example");
  });

  it("lowercases the host but preserves a subpath's case", () => {
    expect(normalizeBaseUrl("HTTPS://Git.Corp.Example/GitLab")).toBe("https://git.corp.example/GitLab");
  });

  it("strips a trailing slash, query and hash", () => {
    expect(normalizeBaseUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeBaseUrl("https://example.com/gitlab/?a=1#frag")).toBe("https://example.com/gitlab");
  });

  it("keeps a self-hosted subpath", () => {
    expect(normalizeBaseUrl("https://example.com/gitlab")).toBe("https://example.com/gitlab");
  });

  it("allows explicit http", () => {
    expect(normalizeBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("returns null for empty or whitespace input", () => {
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl("   ")).toBeNull();
  });

  it("returns null for a non-http(s) scheme", () => {
    expect(normalizeBaseUrl("ftp://example.com")).toBeNull();
    expect(normalizeBaseUrl("javascript:alert(1)")).toBeNull();
  });
});
