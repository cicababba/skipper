import { describe, it, expect, vi, afterEach } from "vitest";
import { listOpenProjectProjects } from "../src/adapters/openproject/projects";

const token = async () => "tok";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listOpenProjectProjects", () => {
  it("maps elements to TrackerProject with key === String(id), ignoring the identifier slug", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        total: 2,
        count: 2,
        _embedded: {
          elements: [
            { id: 5, identifier: "proj-slug", name: "Proj" },
            { id: 8, identifier: "ops", name: "Ops" },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const projects = await listOpenProjectProjects(token, "https://op.example.com");
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://op.example.com/api/v3/projects");
    expect(projects).toEqual([
      { id: "5", key: "5", name: "Proj" },
      { id: "8", key: "8", name: "Ops" },
    ]);
  });

  it("paginates by page number when total exceeds the page count", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const offset = new URL(String(url)).searchParams.get("offset");
      if (offset === "1") {
        return jsonResponse(200, { total: 150, count: 1, _embedded: { elements: [{ id: 5, name: "Proj" }] } });
      }
      return jsonResponse(200, { total: 150, count: 1, _embedded: { elements: [{ id: 8, name: "Ops" }] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const projects = await listOpenProjectProjects(token, "https://op.example.com");
    expect(projects).toEqual([
      { id: "5", key: "5", name: "Proj" },
      { id: "8", key: "8", name: "Ops" },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain("offset=1");
    expect(fetchMock.mock.calls[1][0]).toContain("offset=2");
  });

  it("sends HTTP Basic auth when authMethod is pat", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { total: 0, count: 0, _embedded: { elements: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await listOpenProjectProjects(token, "https://op.example.com", "pat");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("apikey:tok").toString("base64")}`);
  });
});
