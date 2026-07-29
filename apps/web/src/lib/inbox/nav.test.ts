import { describe, expect, it } from "vitest";
import { composeHref, itemHref, repoHref, repoSettingsHref, resolveBackHref } from "./nav";

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

  it("stays unchanged when opts is empty or omitted", () => {
    const bare = "/repos/repo?owner=acme&name=widgets";
    expect(repoHref({ owner: "acme", name: "widgets" }, {})).toBe(bare);
    expect(repoHref({ owner: "acme", name: "widgets" }, undefined)).toBe(bare);
  });

  it("appends the memory tab", () => {
    expect(repoHref({ owner: "acme", name: "widgets" }, { tab: "memory" })).toBe(
      "/repos/repo?owner=acme&name=widgets&tab=memory",
    );
  });

  it("appends an encoded prefilled query", () => {
    expect(
      repoHref({ owner: "acme", name: "widgets" }, { tab: "memory", mq: "oauth & pty resize?" }),
    ).toBe("/repos/repo?owner=acme&name=widgets&tab=memory&mq=oauth+%26+pty+resize%3F");
  });

  it("omits an empty query", () => {
    expect(repoHref({ owner: "acme", name: "widgets" }, { tab: "memory", mq: "" })).toBe(
      "/repos/repo?owner=acme&name=widgets&tab=memory",
    );
  });

  it("carries a query without a tab", () => {
    expect(repoHref({ owner: "acme", name: "widgets" }, { mq: "oauth" })).toBe(
      "/repos/repo?owner=acme&name=widgets&mq=oauth",
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

describe("composeHref", () => {
  it("builds a compose href with owner and name", () => {
    expect(composeHref({ owner: "acme", name: "widgets" })).toBe(
      "/compose?owner=acme&name=widgets",
    );
  });

  it("encodes each value", () => {
    expect(composeHref({ owner: "a c", name: "w&d" })).toBe("/compose?owner=a+c&name=w%26d");
  });

  it("appends the quick mode when asked", () => {
    expect(composeHref({ owner: "acme", name: "widgets" }, "quick")).toBe(
      "/compose?owner=acme&name=widgets&mode=quick",
    );
  });

  it("omits the mode when undefined — chat is the bare href", () => {
    expect(composeHref({ owner: "acme", name: "widgets" }, undefined)).toBe(
      "/compose?owner=acme&name=widgets",
    );
  });

  it("appends the draft to resume (#138)", () => {
    expect(composeHref({ owner: "acme", name: "widgets" }, undefined, "draft-1")).toBe(
      "/compose?owner=acme&name=widgets&draft=draft-1",
    );
  });

  it("encodes the draft id", () => {
    expect(composeHref({ owner: "acme", name: "widgets" }, undefined, "a b/c")).toBe(
      "/compose?owner=acme&name=widgets&draft=a+b%2Fc",
    );
  });

  it("omits the draft when undefined or empty", () => {
    const bare = "/compose?owner=acme&name=widgets";
    expect(composeHref({ owner: "acme", name: "widgets" }, undefined, undefined)).toBe(bare);
    expect(composeHref({ owner: "acme", name: "widgets" }, undefined, "")).toBe(bare);
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
