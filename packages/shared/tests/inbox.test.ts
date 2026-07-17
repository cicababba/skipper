import { describe, it, expect } from "vitest";
import { sourceRefKey } from "../src";

describe("sourceRefKey", () => {
  it("joins project and key with a lowercased project", () => {
    expect(sourceRefKey({ project: "Owner/Repo", key: "42" })).toBe("owner/repo#42");
  });

  it("keeps the key verbatim", () => {
    expect(sourceRefKey({ project: "PROJ", key: "PROJ-7" })).toBe("proj#PROJ-7");
  });
});
