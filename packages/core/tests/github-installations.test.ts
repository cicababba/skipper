import { describe, it, expect, vi, afterEach } from "vitest";
import { listUserInstallationRepos } from "../src/github/installations";

const token = async () => "tok";

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function repoPayload(owner: string, name: string, isPrivate = false) {
  return { name, private: isPrivate, owner: { login: owner } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listUserInstallationRepos", () => {
  it("returns zero installations for an empty account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ total_count: 0, installations: [] })),
    );
    const result = await listUserInstallationRepos(token);
    expect(result).toEqual({ installationCount: 0, appSlug: undefined, repos: [] });
  });

  it("walks installations and their repositories with pagination", async () => {
    const reposPage2 = "https://api.github.com/user/installations/11/repositories?per_page=100&page=2";
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com/user/installations?")) {
        return jsonResponse({
          total_count: 2,
          installations: [
            { id: 11, app_slug: "nestbrain-app" },
            { id: 12, app_slug: "nestbrain-app" },
          ],
        });
      }
      if (u === reposPage2) {
        return jsonResponse({ repositories: [repoPayload("o", "beta", true)] });
      }
      if (u.includes("/installations/11/repositories")) {
        return jsonResponse(
          { repositories: [repoPayload("o", "alpha")] },
          { link: `<${reposPage2}>; rel="next"` },
        );
      }
      if (u.includes("/installations/12/repositories")) {
        // duplicate across installations is deduped
        return jsonResponse({ repositories: [repoPayload("O", "Alpha"), repoPayload("x", "gamma")] });
      }
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listUserInstallationRepos(token);
    expect(result.installationCount).toBe(2);
    expect(result.appSlug).toBe("nestbrain-app");
    expect(result.repos).toEqual([
      { owner: "o", name: "alpha", private: false },
      { owner: "o", name: "beta", private: true },
      { owner: "x", name: "gamma", private: false },
    ]);
  });
});
