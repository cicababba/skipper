import { describe, it, expect } from "vitest";
import {
  mapOpenProjectWorkPackage,
  type OpenProjectWorkPackagePayload,
} from "../src/adapters/openproject/map";

const statuses = new Map<string, boolean>([
  ["/api/v3/statuses/1", false],
  ["/api/v3/statuses/12", true],
]);

function payload(over: Partial<OpenProjectWorkPackagePayload> = {}): OpenProjectWorkPackagePayload {
  return {
    id: 42,
    subject: "Fix the thing",
    description: { format: "markdown", raw: "body text" },
    createdAt: "2026-07-10T09:00:00.000+02:00",
    updatedAt: "2026-07-17T10:30:00.000+02:00",
    _links: {
      project: { href: "/api/v3/projects/5", title: "Proj" },
      status: { href: "/api/v3/statuses/1", title: "In progress" },
      assignee: { title: "Ada" },
      author: { title: "Bob" },
    },
    ...over,
  };
}

describe("openproject map", () => {
  it("maps a work package: ids, project from href, links, url, normalized timestamps", () => {
    const issue = mapOpenProjectWorkPackage(payload(), "acct", "https://op.example.com", statuses);
    expect(issue.id).toBe("openproject:42");
    expect(issue.source).toBe("openproject");
    expect(issue.sourceRef).toEqual({ project: "5", key: "42" });
    expect(issue.codeHost).toBe("github"); // placeholder until project→repo mapping fills it
    expect(issue.key).toBe("42");
    expect(issue.number).toBe(42);
    expect(issue.title).toBe("Fix the thing");
    expect(issue.body).toBe("body text");
    expect(issue.labels).toEqual([]);
    expect(issue.assignees).toEqual(["Ada"]);
    expect(issue.author).toBe("Bob");
    expect(issue.url).toBe("https://op.example.com/work_packages/42");
    expect(issue.createdAt).toBe("2026-07-10T07:00:00.000Z");
    expect(issue.updatedAt).toBe("2026-07-17T08:30:00.000Z");
    expect(issue.state).toBe("open");
  });

  it("trims a trailing slash on the base URL before /work_packages", () => {
    const issue = mapOpenProjectWorkPackage(payload(), "acct", "https://op.example.com/", statuses);
    expect(issue.url).toBe("https://op.example.com/work_packages/42");
  });

  it("marks a work package whose status href isClosed as closed", () => {
    const closed = payload({
      _links: {
        project: { href: "/api/v3/projects/5" },
        status: { href: "/api/v3/statuses/12" },
      },
    });
    expect(mapOpenProjectWorkPackage(closed, "acct", "https://op.example.com", statuses).state).toBe(
      "closed",
    );
  });

  it("coerces an empty description raw to undefined", () => {
    const empty = payload({ description: { format: "markdown", raw: "" } });
    expect(mapOpenProjectWorkPackage(empty, "acct", "https://op.example.com", statuses).body).toBeUndefined();
  });

  it("tolerates missing optional fields and an unknown status", () => {
    const issue = mapOpenProjectWorkPackage(
      { id: 7, _links: {} },
      "acct",
      "https://op.example.com",
      statuses,
    );
    expect(issue.title).toBe("");
    expect(issue.body).toBeUndefined();
    expect(issue.labels).toEqual([]);
    expect(issue.assignees).toEqual([]);
    expect(issue.author).toBeUndefined();
    expect(issue.sourceRef.project).toBe(""); // no project href
    expect(issue.state).toBe("open"); // no status href → open
  });
});
