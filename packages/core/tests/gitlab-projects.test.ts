import { describe, it, expect, vi, afterEach } from "vitest";
import { listMembershipProjects } from "../src/adapters/gitlab/projects";

const token = async () => "tok";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listMembershipProjects", () => {
  it("maps nested-group paths and derives the private flag from visibility", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toContain("/projects?membership=true&archived=false&per_page=100");
        return jsonResponse(200, [
          { path_with_namespace: "group/sub/proj", visibility: "private" },
          { path_with_namespace: "octo/demo", visibility: "public" },
        ]);
      }),
    );
    const projects = await listMembershipProjects(token);
    expect(projects).toEqual([
      { repo: { owner: "group/sub", name: "proj" }, private: true },
      { repo: { owner: "octo", name: "demo" }, private: false },
    ]);
  });

  it("walks the Link rel=next pagination", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          [{ path_with_namespace: "octo/one", visibility: "private" }],
          { link: '<https://gitlab.com/api/v4/projects?page=2>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, [{ path_with_namespace: "octo/two", visibility: "internal" }]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const projects = await listMembershipProjects(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://gitlab.com/api/v4/projects?page=2");
    expect(projects).toEqual([
      { repo: { owner: "octo", name: "one" }, private: true },
      { repo: { owner: "octo", name: "two" }, private: true },
    ]);
  });

  it("targets the account's self-hosted instance base URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toContain("https://git.corp/gitlab/api/v4/projects");
        return jsonResponse(200, []);
      }),
    );
    await listMembershipProjects(token, "https://git.corp/gitlab");
  });
});
