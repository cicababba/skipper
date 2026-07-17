import { describe, it, expect } from "vitest";
import {
  mappingHost,
  parseProjectMappingKey,
  projectMappingKey,
  sourceRefKey,
} from "../src";

describe("sourceRefKey", () => {
  it("joins project and key with a lowercased project", () => {
    expect(sourceRefKey({ project: "Owner/Repo", key: "42" })).toBe("owner/repo#42");
  });

  it("keeps the key verbatim", () => {
    expect(sourceRefKey({ project: "PROJ", key: "PROJ-7" })).toBe("proj#PROJ-7");
  });
});

describe("projectMappingKey", () => {
  it("lowercases the host and uppercases the project key", () => {
    expect(projectMappingKey("jira", "Acme.Atlassian.net", "proj")).toBe(
      "jira:acme.atlassian.net:PROJ",
    );
  });
});

describe("mappingHost", () => {
  it("returns the lowercased host of a base URL", () => {
    expect(mappingHost("https://Acme.atlassian.net")).toBe("acme.atlassian.net");
  });

  it("falls back to 'default' when absent or invalid", () => {
    expect(mappingHost()).toBe("default");
    expect(mappingHost("")).toBe("default");
    expect(mappingHost("not a url")).toBe("default");
  });
});

describe("parseProjectMappingKey", () => {
  it("splits a canonical key into its parts", () => {
    expect(parseProjectMappingKey("jira:acme.atlassian.net:PROJ")).toEqual({
      source: "jira",
      host: "acme.atlassian.net",
      projectKey: "PROJ",
    });
  });

  it("round-trips through projectMappingKey", () => {
    const key = projectMappingKey("jira", "acme.atlassian.net", "proj");
    const parts = parseProjectMappingKey(key)!;
    expect(projectMappingKey(parts.source, parts.host, parts.projectKey)).toBe(key);
  });

  it("returns null on malformed input", () => {
    expect(parseProjectMappingKey("jira:acme.atlassian.net")).toBeNull();
    expect(parseProjectMappingKey("jira::PROJ")).toBeNull();
    expect(parseProjectMappingKey("")).toBeNull();
  });
});
