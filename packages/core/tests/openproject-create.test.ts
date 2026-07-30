import { describe, it, expect, vi, afterEach } from "vitest";
import { createOpenProjectIssue } from "../src/adapters/openproject/create";
import type { CreateIssueParams } from "../src/adapters/types";

const token = async () => "tok";
const BASE_URL = "https://op.example.com";

function params(over: Partial<CreateIssueParams> = {}): CreateIssueParams {
  return {
    repo: { owner: "o", name: "r" },
    title: "t",
    accountId: "acc-1",
    project: "5",
    ...over,
  };
}

function typesBody(elements: unknown[] = [{ id: 1, name: "Task", _links: { self: { href: "/api/v3/types/1" } } }]) {
  return { _embedded: { elements } };
}

function wpPayload(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    subject: "t",
    description: { format: "markdown", raw: "why" },
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    _links: {
      project: { href: "/api/v3/projects/5", title: "Proj" },
      status: { href: "/api/v3/statuses/1", title: "New" },
      assignee: { title: "Ada" },
      author: { title: "Bob" },
    },
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Types lookup then the work-package POST. */
function routeFetch(types = typesBody()) {
  return vi.fn(async (url: string | URL) =>
    String(url).endsWith("/types")
      ? jsonResponse(200, types)
      : jsonResponse(201, wpPayload()),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenProjectIssue", () => {
  it("throws without a project and never touches the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createOpenProjectIssue(params({ project: undefined }), token, BASE_URL),
    ).rejects.toThrow(/needs a project/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws without a baseUrl", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(createOpenProjectIssue(params(), token)).rejects.toThrow(
      "OpenProject target requires a baseUrl",
    );
  });

  it("resolves the project's types and POSTs the work package", async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);

    await createOpenProjectIssue(params({ body: "why" }), token, BASE_URL);

    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE_URL}/api/v3/projects/5/types`);
    const [postUrl, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(String(postUrl)).toBe(`${BASE_URL}/api/v3/work_packages`);
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(String(postInit.body))).toEqual({
      subject: "t",
      description: { format: "markdown", raw: "why" },
      _links: {
        project: { href: "/api/v3/projects/5" },
        type: { href: "/api/v3/types/1" },
      },
    });
  });

  it("omits the description when the caller sends no body", async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);

    await createOpenProjectIssue(params(), token, BASE_URL);

    const [, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(postInit.body))).not.toHaveProperty("description");
  });

  it("prefers a type named Task whatever its position", async () => {
    const fetchMock = routeFetch(
      typesBody([
        { id: 7, name: "Bug", _links: { self: { href: "/api/v3/types/7" } } },
        { id: 1, name: "task", _links: { self: { href: "/api/v3/types/1" } } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createOpenProjectIssue(params(), token, BASE_URL);

    const [, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(postInit.body))._links.type).toEqual({ href: "/api/v3/types/1" });
  });

  it("falls back to the first type, synthesizing the href when the payload has none", async () => {
    const fetchMock = routeFetch(typesBody([{ id: 7, name: "Bug" }]));
    vi.stubGlobal("fetch", fetchMock);

    await createOpenProjectIssue(params(), token, BASE_URL);

    const [, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(postInit.body))._links.type).toEqual({ href: "/api/v3/types/7" });
  });

  it("throws a clear error when the project offers no type", async () => {
    vi.stubGlobal("fetch", routeFetch(typesBody([])));

    await expect(createOpenProjectIssue(params(), token, BASE_URL)).rejects.toThrow(
      "OpenProject project 5 offers no work-package types",
    );
  });

  it("authenticates both requests with HTTP Basic when the account uses a PAT", async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);

    await createOpenProjectIssue(params(), token, BASE_URL, "pat");

    const expected = `Basic ${Buffer.from("apikey:tok").toString("base64")}`;
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>).authorization).toBe(expected);
    }
  });

  it("returns the created work package mapped as an open Issue", async () => {
    vi.stubGlobal("fetch", routeFetch());

    const issue = await createOpenProjectIssue(params({ body: "why" }), token, BASE_URL);

    expect(issue).toEqual({
      id: "openproject:42",
      kind: "issue",
      source: "openproject",
      sourceRef: { project: "5", key: "42" },
      codeHost: "github",
      accountId: "acc-1",
      key: "42",
      number: 42,
      title: "t",
      body: "why",
      labels: [],
      assignees: ["Ada"],
      author: "Bob",
      url: `${BASE_URL}/work_packages/42`,
      createdAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:00:00.000Z",
      state: "open",
    });
  });

  it("propagates an ApiError from the POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/types")
          ? jsonResponse(200, typesBody())
          : jsonResponse(422, { message: "unprocessable" }),
      ),
    );

    await expect(createOpenProjectIssue(params(), token, BASE_URL)).rejects.toMatchObject({
      status: 422,
    });
  });
});
