import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MemoryHit, SolutionRecord, StoredPlan } from "@skipper/shared";
import { MemoryBrowser } from "./memory-browser";

const REPO = { owner: "acme", name: "rocket" };

function planWith(summary: string, files: string[]): StoredPlan {
  return {
    version: 2,
    itemId: "github:1",
    repo: REPO,
    generatedAt: "2026-07-01T00:00:00.000Z",
    model: "test",
    plan: {
      summary,
      files: files.map((path) => ({ path, reason: "touched" })),
      steps: [],
      acceptance: [],
      risks: [],
      openQuestions: [],
      estimatedSize: "s",
    },
  };
}

function solution(itemId: string, overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 1,
    itemId,
    repo: REPO,
    issueNumber: 42,
    title: `solution ${itemId}`,
    url: "https://example.test/42",
    pr: { number: 8, url: "https://example.test/pr/8" },
    plan: planWith("summary of the fix", ["src/auth/oauth.ts"]),
    outcome: "merged",
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function note(itemId: string, overrides: Partial<SolutionRecord> = {}): SolutionRecord {
  return {
    version: 1,
    itemId,
    repo: REPO,
    title: "a manual note",
    url: "",
    kind: "note",
    note: { body: "always debounce the resize", files: ["src/terminal.ts"] },
    capturedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function hitFor(rec: SolutionRecord, score = 1): MemoryHit {
  return {
    id: rec.itemId,
    ref: `${rec.itemId}.json`,
    score,
    title: rec.title,
    issueKey: rec.issueKey ?? String(rec.issueNumber ?? ""),
    url: rec.url,
    pr: rec.pr,
    kind: rec.kind,
    planSummary: rec.plan?.plan.summary,
    filesTouched: rec.diffStats?.files ?? rec.note?.files ?? [],
    capturedAt: rec.capturedAt,
  };
}

function installSkipper(opts: {
  records?: SolutionRecord[];
  search?: { ok: true; hits: MemoryHit[] } | { ok: false; error: string };
  repoFiles?: { ok: true; files: string[] } | { ok: false; error: string };
}) {
  const list = vi.fn().mockResolvedValue(opts.records ?? []);
  const search = vi.fn().mockResolvedValue(opts.search ?? { ok: true, hits: [] });
  const createNote = vi.fn().mockResolvedValue({ ok: true, id: "note:new" });
  const updateNote = vi.fn().mockResolvedValue({ ok: true });
  const curate = vi.fn().mockResolvedValue({ ok: true });
  const remove = vi.fn().mockResolvedValue({ ok: true });
  const repoFiles = vi
    .fn()
    .mockResolvedValue(opts.repoFiles ?? { ok: true, files: ["src/terminal.ts"] });
  (window as unknown as { skipper: unknown }).skipper = {
    memory: { list, search, createNote, updateNote, curate, delete: remove, repoFiles },
    openExternal: vi.fn(),
  };
  return { list, search, createNote, repoFiles };
}

function type(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/Search memory/), { target: { value } });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("MemoryBrowser — chronological browsing", () => {
  it("lists the repo's records newest first when the query is empty", async () => {
    installSkipper({
      records: [
        solution("github:1", { title: "older fix", capturedAt: "2026-01-01T00:00:00.000Z" }),
        solution("github:2", { title: "newer fix", capturedAt: "2026-07-01T00:00:00.000Z" }),
      ],
    });
    render(<MemoryBrowser repo={REPO} />);

    await screen.findByText("newer fix");
    const titles = screen
      .getAllByText((_, el) => el?.textContent === "newer fix" || el?.textContent === "older fix")
      .filter((el) => el.tagName === "SPAN")
      .map((el) => el.textContent);
    expect(titles).toEqual(["newer fix", "older fix"]);
  });

  it("never searches while the field is empty", async () => {
    const { search } = installSkipper({ records: [solution("github:1")] });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText("solution github:1");
    expect(search).not.toHaveBeenCalled();
  });

  it("shows the empty-state copy with no records", async () => {
    installSkipper({ records: [] });
    render(<MemoryBrowser repo={REPO} />);
    expect(await screen.findByText(/No captured solutions for this repo yet/)).toBeTruthy();
  });
});

describe("MemoryBrowser — search", () => {
  it("debounces a burst into one search for the final query", async () => {
    const { search } = installSkipper({ records: [solution("github:1")] });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText("solution github:1");

    for (const v of ["o", "oa", "oau", "oauth"]) type(v);

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(search).toHaveBeenCalledWith(REPO, "oauth", 20);
  });

  it("renders the ranked hits and drops back to the list when cleared", async () => {
    const rec = solution("github:1", { title: "the oauth fix" });
    const { search } = installSkipper({
      records: [rec, solution("github:2", { title: "unrelated" })],
      search: { ok: true, hits: [hitFor(rec)] },
    });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText("unrelated");

    type("oauth");
    await waitFor(() => expect(search).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("unrelated")).toBeNull());
    expect(screen.getByText("the oauth fix")).toBeTruthy();

    type("");
    await waitFor(() => expect(screen.getByText("unrelated")).toBeTruthy());
  });

  it("reports no results when the search comes back empty", async () => {
    installSkipper({ records: [solution("github:1")], search: { ok: true, hits: [] } });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText("solution github:1");

    type("nothing matches this");
    expect(await screen.findByText("No matching memories.")).toBeTruthy();
  });

  it("prefills and runs the query from the deep link", async () => {
    const rec = solution("github:1", { title: "the oauth fix" });
    const { search } = installSkipper({ records: [rec], search: { ok: true, hits: [hitFor(rec)] } });
    render(<MemoryBrowser repo={REPO} initialQuery="oauth refresh" />);

    expect((screen.getByPlaceholderText(/Search memory/) as HTMLInputElement).value).toBe(
      "oauth refresh",
    );
    await waitFor(() => expect(search).toHaveBeenCalledWith(REPO, "oauth refresh", 20));
  });

  it("shows the preparing-index copy while the first search runs", async () => {
    let release: (v: { ok: true; hits: MemoryHit[] }) => void = () => {};
    const pending = new Promise<{ ok: true; hits: MemoryHit[] }>((r) => (release = r));
    const { search } = installSkipper({ records: [solution("github:1")] });
    search.mockReturnValue(pending);

    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText("solution github:1");
    type("oauth");

    expect(await screen.findByText("Preparing the memory index…")).toBeTruthy();
    release({ ok: true, hits: [] });
    await waitFor(() => expect(screen.queryByText("Preparing the memory index…")).toBeNull());
  });

  it("surfaces a failed search and retries on demand", async () => {
    const rec = solution("github:1");
    const { search } = installSkipper({
      records: [rec],
      search: { ok: false, error: "model unavailable" },
    });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText("solution github:1");

    type("oauth");
    expect(await screen.findByText(/Search failed: model unavailable/)).toBeTruthy();

    search.mockResolvedValue({ ok: true, hits: [hitFor(rec)] });
    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Search failed/)).toBeNull());
  });
});

describe("MemoryBrowser — notes and file filtering", () => {
  it("renders a note row with its badge and no PR chip", async () => {
    installSkipper({ records: [note("note:1")] });
    render(<MemoryBrowser repo={REPO} />);

    await screen.findByText("a manual note");
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.queryByText("8")).toBeNull();
    expect(screen.getByText("always debounce the resize")).toBeTruthy();
  });

  it("shows the plan summary as the snippet for a solution", async () => {
    installSkipper({ records: [solution("github:1")] });
    render(<MemoryBrowser repo={REPO} />);
    expect(await screen.findByText("summary of the fix")).toBeTruthy();
  });

  it("filters the list via the file dropdown and clears from the chip", async () => {
    installSkipper({
      records: [
        solution("github:1", { title: "oauth work", plan: planWith("s", ["src/auth/oauth.ts"]) }),
        note("note:1"),
      ],
    });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText("oauth work");

    fireEvent.click(screen.getByText("Filter by file"));
    fireEvent.change(screen.getByPlaceholderText("Files"), { target: { value: "terminal" } });
    fireEvent.click(screen.getByRole("button", { name: "src/terminal.ts" }));

    await waitFor(() => expect(screen.queryByText("oauth work")).toBeNull());
    expect(screen.getByText("a manual note")).toBeTruthy();
    expect(screen.getByText("src/terminal.ts")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("clear filter src/terminal.ts"));
    await waitFor(() => expect(screen.getByText("oauth work")).toBeTruthy());
  });

  it("suggests every touched file in the filter dropdown", async () => {
    installSkipper({ records: [solution("github:1"), note("note:1")] });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText("Filter by file");

    fireEvent.click(screen.getByText("Filter by file"));
    fireEvent.change(screen.getByPlaceholderText("Files"), { target: { value: "src" } });
    expect(screen.getByRole("button", { name: "src/auth/oauth.ts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "src/terminal.ts" })).toBeTruthy();
  });
});

describe("MemoryBrowser — note authoring", () => {
  it("creates a note and reloads the list", async () => {
    const { createNote, list } = installSkipper({ records: [] });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText(/No captured solutions/);

    fireEvent.click(screen.getByText("New note"));
    fireEvent.change(screen.getByPlaceholderText(/What did you learn/), {
      target: { value: "remember this" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(createNote).toHaveBeenCalledWith(REPO, "remember this", [], ""));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("refuses to save an empty body", async () => {
    const { createNote } = installSkipper({ records: [] });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText(/No captured solutions/);

    fireEvent.click(screen.getByText("New note"));
    fireEvent.click(screen.getByText("Save"));
    expect(createNote).not.toHaveBeenCalled();
  });

  it("hints instead of offering autocomplete when the repo is not linked", async () => {
    installSkipper({ records: [], repoFiles: { ok: false, error: "repo not linked" } });
    render(<MemoryBrowser repo={REPO} />);
    await screen.findByText(/No captured solutions/);

    fireEvent.click(screen.getByText("New note"));
    expect(await screen.findByText("Link a local clone to attach files.")).toBeTruthy();
  });
});
