import { describe, it, expect, vi, afterEach } from "vitest";
import { pollOpenProjectAccount } from "../src/adapters/openproject/poll";
import { ApiError } from "../src/adapters/types";

const token = async () => "tok";
const BASE_URL = "https://op.example.com";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function statusesBody() {
  return {
    _embedded: {
      elements: [
        { isClosed: false, _links: { self: { href: "/api/v3/statuses/1" } } },
        { isClosed: true, _links: { self: { href: "/api/v3/statuses/12" } } },
      ],
    },
  };
}

function wp(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    subject: "Fix the thing",
    description: { format: "markdown", raw: "body text" },
    createdAt: "2026-07-10T09:00:00.000Z",
    updatedAt: "2026-07-17T10:30:00.000Z",
    _links: {
      project: { href: "/api/v3/projects/5", title: "Proj" },
      status: { href: "/api/v3/statuses/1", title: "In progress" },
      assignee: { title: "Ada" },
      author: { title: "Bob" },
    },
    ...over,
  };
}

function wpCollection(elements: unknown[], total = elements.length) {
  return { total, count: elements.length, _embedded: { elements } };
}

/** Routes /statuses to the status collection and everything else (work_packages)
 *  through `workPackages(url)`. */
function routeFetch(workPackages: (url: URL) => Response) {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/statuses")) return jsonResponse(200, statusesBody());
    return workPackages(url);
  });
}

/** Work-package request URLs, in call order (statuses calls filtered out). */
function wpUrls(mock: ReturnType<typeof vi.fn>): URL[] {
  return mock.mock.calls
    .map((c) => new URL(String(c[0])))
    .filter((u) => u.pathname.endsWith("/work_packages"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pollOpenProjectAccount — full walk", () => {
  const base = { accountId: "acct", getToken: token, baseUrl: BASE_URL };

  it("fetches statuses, filters assignee-me + open, sorts by updatedAt, paginates by page number", async () => {
    const fetchMock = routeFetch((url) => {
      const offset = url.searchParams.get("offset");
      if (offset === "1") return jsonResponse(200, wpCollection([wp()], 2));
      return jsonResponse(
        200,
        wpCollection([wp({ id: 43, updatedAt: "2026-07-15T08:00:00.000Z" })], 2),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollOpenProjectAccount(base);

    // statuses once + two work-package pages.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/v3/statuses"))).toBe(true);
    const urls = wpUrls(fetchMock);
    expect(urls).toHaveLength(2);
    expect(urls[0].origin + urls[0].pathname).toBe("https://op.example.com/api/v3/work_packages");
    expect(JSON.parse(urls[0].searchParams.get("filters")!)).toEqual([
      { assignee: { operator: "=", values: ["me"] } },
      { status: { operator: "o", values: [] } },
    ]);
    expect(urls[0].searchParams.get("sortBy")).toBe('[["updatedAt","desc"]]');
    expect(urls[0].searchParams.get("offset")).toBe("1");
    expect(urls[0].searchParams.get("pageSize")).toBe("100");
    expect(urls[1].searchParams.get("offset")).toBe("2");

    expect(result.mode).toBe("full");
    expect(result.pullRequests).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].id).toBe("openproject:42");
    expect(result.issues[0].source).toBe("openproject");
    // Cursor = max updatedAt across the page.
    expect(result.cursor.issues.updatedAfter).toBe("2026-07-17T10:30:00.000Z");
  });

  it("stops paginating once the collected count reaches total", async () => {
    const fetchMock = routeFetch(() => jsonResponse(200, wpCollection([wp()], 1)));
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollOpenProjectAccount(base);
    expect(wpUrls(fetchMock)).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
  });
});

describe("pollOpenProjectAccount — delta", () => {
  const base = { accountId: "acct", getToken: token, baseUrl: BASE_URL };

  it("uses a <>d updatedAt filter with 120s overlap and drops the open filter", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const updatedAfter = new Date(now.getTime() - 10 * 60_000).toISOString();
    const cursor = { version: 1 as const, issues: { updatedAfter } };
    const fetchMock = routeFetch(() => jsonResponse(200, wpCollection([wp()])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollOpenProjectAccount({ ...base, cursor });
    expect(result.mode).toBe("delta");
    const expectedSince = new Date(Date.parse(updatedAfter) - 120_000).toISOString();
    expect(JSON.parse(wpUrls(fetchMock)[0].searchParams.get("filters")!)).toEqual([
      { assignee: { operator: "=", values: ["me"] } },
      { updatedAt: { operator: "<>d", values: [expectedSince, ""] } },
    ]);
  });

  it("surfaces a just-closed work package as a delta item", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cursor = {
      version: 1 as const,
      issues: { updatedAfter: new Date(now.getTime() - 5 * 60_000).toISOString() },
    };
    const closed = wp({ _links: { project: { href: "/api/v3/projects/5" }, status: { href: "/api/v3/statuses/12" } } });
    vi.stubGlobal("fetch", routeFetch(() => jsonResponse(200, wpCollection([closed]))));

    const result = await pollOpenProjectAccount({ ...base, cursor });
    expect(result.mode).toBe("delta");
    expect(result.issues[0].state).toBe("closed");
  });

  it("keeps the previous updatedAfter on an empty delta", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const prev = new Date(now.getTime() - 5 * 60_000).toISOString();
    vi.stubGlobal("fetch", routeFetch(() => jsonResponse(200, wpCollection([]))));

    const result = await pollOpenProjectAccount({
      ...base,
      cursor: { version: 1, issues: { updatedAfter: prev } },
    });
    expect(result.cursor.issues.updatedAfter).toBe(prev);
  });

  it("full-walks a stale cursor (30 days)", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const stale = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
    const fetchMock = routeFetch(() => jsonResponse(200, wpCollection([])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollOpenProjectAccount({
      ...base,
      cursor: { version: 1, issues: { updatedAfter: stale } },
    });
    expect(result.mode).toBe("full");
    expect(JSON.parse(wpUrls(fetchMock)[0].searchParams.get("filters")!)[1]).toEqual({
      status: { operator: "o", values: [] },
    });
  });

  it("full-walks a malformed cursor object", async () => {
    const fetchMock = routeFetch(() => jsonResponse(200, wpCollection([])));
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollOpenProjectAccount({
      ...base,
      cursor: { version: 2, issues: {} } as never,
    });
    expect(result.mode).toBe("full");
  });

  it("recovers a 400-rejected cursor with a full walk", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetchMock = routeFetch((url) => {
      const filters = url.searchParams.get("filters")!;
      // The delta filter is rejected; the full-walk retry (open filter) succeeds.
      if (filters.includes("<>d")) return jsonResponse(400, { message: "bad filter" });
      return jsonResponse(200, wpCollection([wp()]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollOpenProjectAccount({
      ...base,
      cursor: { version: 1, issues: { updatedAfter: new Date(now.getTime() - 60_000).toISOString() } },
    });
    expect(result.mode).toBe("full");
    const urls = wpUrls(fetchMock);
    expect(urls[urls.length - 1].searchParams.get("filters")).toContain('"o"');
  });

  it("rethrows a 400 when no cursor is in play", async () => {
    vi.stubGlobal("fetch", routeFetch(() => jsonResponse(400, { message: "bad filter" })));
    const err = await pollOpenProjectAccount(base).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });

  it("sends the token as HTTP Basic when authMethod is pat", async () => {
    const fetchMock = routeFetch(() => jsonResponse(200, wpCollection([wp()])));
    vi.stubGlobal("fetch", fetchMock);
    await pollOpenProjectAccount({ ...base, authMethod: "pat" });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("apikey:tok").toString("base64")}`);
  });
});
