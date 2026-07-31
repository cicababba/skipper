import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { fetchOpenProjectDependencies } from "../src/adapters/openproject/dependencies";

const token = async () => "tok";
const BASE = "https://op.example.com";

function opIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "openproject:42",
    kind: "issue",
    source: "openproject",
    sourceRef: { project: "5", key: "42" },
    codeHost: "github",
    accountId: "a",
    key: "42",
    number: 42,
    title: "t",
    labels: [],
    assignees: [],
    url: `${BASE}/work_packages/42`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    ...over,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function wpHref(id: string | number): string {
  return `/api/v3/work_packages/${id}`;
}

function relation(type: string, from: string | number, to: string | number) {
  return { type, _links: { from: { href: wpHref(from) }, to: { href: wpHref(to) } } };
}

/** Routes /relations to the given elements and every work-package GET to a
 *  payload whose project href is the id times ten, so the mapping is observable. */
function stubApi(elements: unknown[]) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/relations")) {
      return jsonResponse({ _embedded: { elements } });
    }
    const id = /\/work_packages\/(\d+)$/.exec(href)?.[1] ?? "0";
    return jsonResponse({ _links: { project: { href: `/api/v3/projects/${Number(id) * 10}` } } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOpenProjectDependencies", () => {
  it("builds the relations URL from issue.key", async () => {
    const fetchMock = stubApi([]);
    await fetchOpenProjectDependencies(opIssue(), token, BASE);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/api/v3/work_packages/42/relations`);
  });

  it("treats 'blocks' and 'precedes' pointing at self as prerequisites, and resolves their project", async () => {
    stubApi([relation("blocks", 7, 42), relation("precedes", 9, 42)]);
    const refs = await fetchOpenProjectDependencies(opIssue(), token, BASE);
    expect(refs).toEqual([
      { project: "70", key: "7" },
      { project: "90", key: "9" },
    ]);
  });

  it("handles the reversed spellings, where self is the 'from' side", async () => {
    stubApi([relation("blocked", 42, 7), relation("follows", 42, 9)]);
    const refs = await fetchOpenProjectDependencies(opIssue(), token, BASE);
    expect(refs).toEqual([
      { project: "70", key: "7" },
      { project: "90", key: "9" },
    ]);
  });

  it("ignores relations that don't make this work package the dependent side", async () => {
    stubApi([
      relation("relates", 7, 42),
      relation("blocks", 42, 7), // this one blocks 7, not the reverse
      relation("follows", 7, 42),
    ]);
    expect(await fetchOpenProjectDependencies(opIssue(), token, BASE)).toEqual([]);
  });

  it("dedupes repeated blockers and drops a self-relation", async () => {
    stubApi([relation("blocks", 7, 42), relation("precedes", 7, 42), relation("blocks", 42, 42)]);
    expect(await fetchOpenProjectDependencies(opIssue(), token, BASE)).toEqual([
      { project: "70", key: "7" },
    ]);
  });

  it("falls back to body parsing when there are no relations", async () => {
    stubApi([]);
    const refs = await fetchOpenProjectDependencies(
      opIssue({ body: "Blocked by #17" }),
      token,
      BASE,
    );
    expect(refs).toEqual([{ project: "5", key: "17" }]);
  });

  it("sends the PAT Basic auth header on every call", async () => {
    const fetchMock = stubApi([relation("blocks", 7, 42)]);
    await fetchOpenProjectDependencies(opIssue(), token, BASE, "pat");
    const expected = `Basic ${Buffer.from("apikey:tok").toString("base64")}`;
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers((call[1] as RequestInit).headers);
      expect(headers.get("authorization")).toBe(expected);
    }
  });
});
