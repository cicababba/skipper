import { describe, it, expect } from "vitest";
import {
  formatRepoMappingValue,
  mappingHost,
  parseProjectMappingKey,
  parseRepoMappingValue,
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

describe("parseRepoMappingValue / formatRepoMappingValue", () => {
  it("reads a bare owner/name as github", () => {
    expect(parseRepoMappingValue("octo/demo")).toEqual({
      codeHost: "github",
      repo: { owner: "octo", name: "demo" },
    });
  });

  it("reads a host-prefixed value", () => {
    expect(parseRepoMappingValue("bitbucket:ws/repo")).toEqual({
      codeHost: "bitbucket",
      repo: { owner: "ws", name: "repo" },
    });
    expect(parseRepoMappingValue("gitlab:group/proj")).toEqual({
      codeHost: "gitlab",
      repo: { owner: "group", name: "proj" },
    });
  });

  it("keeps a nested-group owner by splitting at the last slash", () => {
    expect(parseRepoMappingValue("gitlab:group/sub/proj")).toEqual({
      codeHost: "gitlab",
      repo: { owner: "group/sub", name: "proj" },
    });
    expect(parseRepoMappingValue("group/sub/proj")).toEqual({
      codeHost: "github",
      repo: { owner: "group/sub", name: "proj" },
    });
  });

  it("returns undefined for an unknown prefix or a missing half", () => {
    expect(parseRepoMappingValue("bogus:ws/repo")).toBeUndefined();
    expect(parseRepoMappingValue("no-slash")).toBeUndefined();
    expect(parseRepoMappingValue("bitbucket:no-slash")).toBeUndefined();
  });

  it("formats github bare and other hosts with a prefix", () => {
    expect(formatRepoMappingValue("github", { owner: "octo", name: "demo" })).toBe("octo/demo");
    expect(formatRepoMappingValue("bitbucket", { owner: "ws", name: "repo" })).toBe(
      "bitbucket:ws/repo",
    );
  });

  it("round-trips through format and parse", () => {
    for (const value of ["octo/demo", "bitbucket:ws/repo", "gitlab:group/proj", "gitlab:group/sub/proj"]) {
      const parsed = parseRepoMappingValue(value)!;
      expect(formatRepoMappingValue(parsed.codeHost, parsed.repo)).toBe(value);
    }
  });
});
