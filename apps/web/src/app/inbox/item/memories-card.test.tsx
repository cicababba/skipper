import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SolutionRecord, StoredPlan, UsedMemoryRef } from "@skipper/shared";
import { MemoriesCard, MemoriesList } from "./memories-card";

// The "memories used" card (#46) after the #255 changes: records may now lack a
// pr (manual notes), carry a plan-summary snippet, and offer a link into the
// repo's Memory tab. This is the only coverage of that surface.

const REPO = { owner: "acme", name: "rocket" };

const PLAN: StoredPlan = {
  version: 2,
  itemId: "github:1",
  repo: REPO,
  generatedAt: "2026-07-01T00:00:00.000Z",
  model: "test",
  plan: {
    summary: "swap the expiry comparison operator",
    files: [],
    steps: [],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
  },
};

function solution(overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 1,
    itemId: "github:1",
    repo: REPO,
    issueNumber: 42,
    title: "fix oauth token refresh",
    url: "https://example.test/42",
    pr: { number: 8, url: "https://example.test/pr/8" },
    plan: PLAN,
    outcome: "merged",
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function note(overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 1,
    itemId: "note:abc",
    repo: REPO,
    title: "a manual note",
    url: "",
    kind: "note",
    note: { body: "always debounce the resize" },
    capturedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function installSkipper(records: Record<string, SolutionRecord | null>) {
  const get = vi.fn(async (id: string) => records[id] ?? null);
  const feedback = vi.fn().mockResolvedValue({ ok: true });
  const openExternal = vi.fn();
  (window as unknown as { skipper: unknown }).skipper = {
    memory: { get, feedback },
    openExternal,
  };
  return { get, feedback, openExternal };
}

const ref = (id: string, vote?: "up" | "down"): UsedMemoryRef =>
  ({ id, ...(vote ? { vote } : {}) }) as UsedMemoryRef;

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("MemoriesList — record rendering", () => {
  it("renders a captured solution with its key, PR chip and summary snippet", async () => {
    installSkipper({ "github:1": solution() });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1")]} />);

    expect(await screen.findByText("fix oauth token refresh")).toBeTruthy();
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
    expect(screen.getByText("swap the expiry comparison operator")).toBeTruthy();
  });

  it("renders a pr-less note without crashing and without a PR chip", async () => {
    installSkipper({ "note:abc": note() });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("note:abc")]} />);

    expect(await screen.findByText("a manual note")).toBeTruthy();
    expect(screen.queryByText("8")).toBeNull();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("never prints the string \"undefined\" for a record with no key at all", async () => {
    installSkipper({
      "github:1": solution({ issueKey: undefined, issueNumber: undefined, pr: undefined }),
    });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1")]} />);

    await screen.findByText("fix oauth token refresh");
    expect(document.body.textContent).not.toContain("undefined");
  });

  it("omits the snippet when the record has no plan", async () => {
    installSkipper({ "github:1": solution({ plan: undefined }) });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1")]} />);

    await screen.findByText("fix oauth token refresh");
    expect(screen.queryByText("swap the expiry comparison operator")).toBeNull();
  });

  it("opens the issue and the PR externally", async () => {
    const { openExternal } = installSkipper({ "github:1": solution() });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1")]} />);

    fireEvent.click(await screen.findByText("fix oauth token refresh"));
    expect(openExternal).toHaveBeenCalledWith("https://example.test/42");

    fireEvent.click(screen.getByText("8"));
    expect(openExternal).toHaveBeenCalledWith("https://example.test/pr/8");
  });

  it("degrades to a load-failed line when the record is gone", async () => {
    installSkipper({ "github:1": null });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1")]} />);
    expect(await screen.findByText("Could not load this memory.")).toBeTruthy();
  });

  it("renders nothing without refs", () => {
    installSkipper({});
    const { container } = render(
      <MemoriesList itemId="item-1" phase="planning" refs={[]} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("MemoriesList — search memory link", () => {
  it("links to the repo's Memory tab with the query prefilled", async () => {
    installSkipper({ "github:1": solution() });
    render(
      <MemoriesList
        itemId="item-1"
        phase="planning"
        refs={[ref("github:1")]}
        repo={REPO}
        queryText="fix oauth token refresh"
      />,
    );

    const link = await screen.findByText("Search memory");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "/repos/repo?owner=acme&name=rocket&tab=memory&mq=fix+oauth+token+refresh",
    );
  });

  it("encodes a query with special characters", async () => {
    installSkipper({ "github:1": solution() });
    render(
      <MemoriesList
        itemId="item-1"
        phase="planning"
        refs={[ref("github:1")]}
        repo={REPO}
        queryText="pty resize & auth?"
      />,
    );

    const link = await screen.findByText("Search memory");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "/repos/repo?owner=acme&name=rocket&tab=memory&mq=pty+resize+%26+auth%3F",
    );
  });

  it("still links to the tab when no query text is given", async () => {
    installSkipper({ "github:1": solution() });
    render(
      <MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1")]} repo={REPO} />,
    );

    const link = await screen.findByText("Search memory");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "/repos/repo?owner=acme&name=rocket&tab=memory",
    );
  });

  it("omits the link entirely when no repo is passed", async () => {
    installSkipper({ "github:1": solution() });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1")]} />);

    await screen.findByText("fix oauth token refresh");
    expect(screen.queryByText("Search memory")).toBeNull();
  });
});

describe("MemoriesList — voting", () => {
  it("casts an up vote for the phase and item", async () => {
    const { feedback } = installSkipper({ "github:1": solution() });
    render(<MemoriesList itemId="item-1" phase="coding" refs={[ref("github:1")]} />);

    fireEvent.click(await screen.findByLabelText("Mark helpful"));
    await waitFor(() =>
      expect(feedback).toHaveBeenCalledWith("item-1", "coding", "github:1", "up"),
    );
  });

  it("toggles an existing vote off", async () => {
    const { feedback } = installSkipper({ "github:1": solution() });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1", "up")]} />);

    const up = await screen.findByLabelText("Mark helpful");
    expect(up.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(up);
    await waitFor(() =>
      expect(feedback).toHaveBeenCalledWith("item-1", "planning", "github:1", null),
    );
  });

  it("hides the vote buttons on a record that failed to load", async () => {
    installSkipper({ "github:1": null });
    render(<MemoriesList itemId="item-1" phase="planning" refs={[ref("github:1")]} />);

    await screen.findByText("Could not load this memory.");
    expect(screen.queryByLabelText("Mark helpful")).toBeNull();
  });
});

describe("MemoriesCard", () => {
  it("renders nothing when the run consulted no memory", () => {
    installSkipper({});
    const { container } = render(
      <MemoriesCard itemId="item-1" phase="planning" refs={undefined} title="Memories consulted" />,
    );
    expect(container.textContent).toBe("");
  });

  it("wraps the list in a titled section and passes the link props through", async () => {
    installSkipper({ "note:abc": note() });
    render(
      <MemoriesCard
        itemId="item-1"
        phase="planning"
        refs={[ref("note:abc")]}
        title="Memories consulted"
        repo={REPO}
        queryText="resize"
      />,
    );

    expect(screen.getByText("Memories consulted")).toBeTruthy();
    expect(await screen.findByText("a manual note")).toBeTruthy();
    expect(screen.getByText("Search memory").closest("a")?.getAttribute("href")).toBe(
      "/repos/repo?owner=acme&name=rocket&tab=memory&mq=resize",
    );
  });
});
