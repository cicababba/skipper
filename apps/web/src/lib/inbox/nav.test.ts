import { describe, expect, it } from "vitest";
import { itemHref, repoHref, repoSettingsHref, resolveBackHref } from "./nav";

describe("itemHref", () => {
  it("builds an item href with the id", () => {
    expect(itemHref("123")).toBe("/inbox/item?id=123");
  });

  it("appends an encoded from param", () => {
    expect(itemHref("123", "/inbox?repo=acme/widgets")).toBe(
      "/inbox/item?id=123&from=%2Finbox%3Frepo%3Dacme%2Fwidgets",
    );
  });

  it("omits from when null", () => {
    expect(itemHref("123", null)).toBe("/inbox/item?id=123");
  });

  it("encodes a slash-bearing id", () => {
    expect(itemHref("JIRA-1/foo")).toBe("/inbox/item?id=JIRA-1%2Ffoo");
  });
});

describe("repoHref", () => {
  it("builds a repo href with owner and name", () => {
    expect(repoHref({ owner: "acme", name: "widgets" })).toBe(
      "/repos/repo?owner=acme&name=widgets",
    );
  });

  it("encodes special characters", () => {
    expect(repoHref({ owner: "a c", name: "w&t" })).toBe(
      "/repos/repo?owner=a+c&name=w%26t",
    );
  });
});

describe("repoSettingsHref", () => {
  it("builds a settings href with owner and name", () => {
    expect(repoSettingsHref({ owner: "acme", name: "widgets" })).toBe(
      "/repos/repo/settings?owner=acme&name=widgets",
    );
  });
});

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
