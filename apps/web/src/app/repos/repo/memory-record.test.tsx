import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SolutionRecord, StoredPlan } from "@skipper/shared";
import { MemoryRecordView } from "./memory-record";

const REPO = { owner: "acme", name: "rocket" };

const PLAN: StoredPlan = {
  version: 2,
  itemId: "github:1",
  repo: REPO,
  generatedAt: "2026-07-01T00:00:00.000Z",
  model: "test",
  plan: {
    summary: "swap the expiry comparison",
    files: [{ path: "src/auth/oauth.ts", reason: "touched" }],
    steps: [{ title: "fix the comparison", detail: "", files: [], symbols: [] }],
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
    diff: "diff --git a/src/auth/oauth.ts b/src/auth/oauth.ts",
    diffStats: { filesChanged: 1, totalChangedLines: 10, files: ["src/auth/oauth.ts"] },
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
    title: "PTY resize",
    url: "",
    kind: "note",
    note: { body: "## Heading\n\nalways debounce the resize", files: ["src/terminal.ts"] },
    capturedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function installSkipper() {
  const curate = vi.fn().mockResolvedValue({ ok: true });
  const updateNote = vi.fn().mockResolvedValue({ ok: true });
  const repoFiles = vi.fn().mockResolvedValue({ ok: true, files: ["src/terminal.ts"] });
  const openExternal = vi.fn();
  (window as unknown as { skipper: unknown }).skipper = {
    memory: { curate, updateNote, repoFiles },
    openExternal,
  };
  return { curate, updateNote, openExternal };
}

function renderView(record: SolutionRecord, props: Record<string, unknown> = {}) {
  const onChanged = vi.fn();
  const onDelete = vi.fn();
  const onBack = vi.fn();
  render(
    <MemoryRecordView
      record={record}
      busy={false}
      onBack={onBack}
      onDelete={onDelete}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { onChanged, onDelete, onBack };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("MemoryRecordView — solutions", () => {
  it("leads with the plan summary and keeps plan/diff collapsed", () => {
    installSkipper();
    renderView(solution());

    expect(screen.getAllByText("swap the expiry comparison")).toHaveLength(1);
    expect(screen.queryByText("fix the comparison")).toBeNull();
    expect(screen.queryByText(/diff --git/)).toBeNull();
  });

  it("expands the plan and the diff on demand", async () => {
    installSkipper();
    renderView(solution());

    fireEvent.click(screen.getByText("Plan"));
    expect(await screen.findByText("fix the comparison")).toBeTruthy();

    fireEvent.click(screen.getByText("Diff"));
    expect(await screen.findByText(/diff --git/)).toBeTruthy();
  });

  it("shows the issue key and opens the PR link", () => {
    const { openExternal } = installSkipper();
    renderView(solution());

    expect(screen.getByText("#42")).toBeTruthy();
    fireEvent.click(screen.getByText("8"));
    expect(openExternal).toHaveBeenCalledWith("https://example.test/pr/8");
  });

  it("falls back to the no-summary copy for a planless record", () => {
    installSkipper();
    renderView(solution({ plan: undefined }));
    expect(screen.getByText("No summary captured.")).toBeTruthy();
  });

  it("renders the touched files", () => {
    installSkipper();
    renderView(solution());
    expect(screen.getByText("src/auth/oauth.ts")).toBeTruthy();
  });
});

describe("MemoryRecordView — notes", () => {
  it("renders the markdown body with no PR link and no plan/diff sections", () => {
    installSkipper();
    renderView(note());

    expect(screen.getByText("Heading")).toBeTruthy();
    expect(screen.getByText("always debounce the resize")).toBeTruthy();
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.queryByText("Plan")).toBeNull();
    expect(screen.queryByText("Diff")).toBeNull();
    expect(screen.queryByText("8")).toBeNull();
  });

  it("lists the note's linked files", () => {
    installSkipper();
    renderView(note());
    expect(screen.getByText("src/terminal.ts")).toBeTruthy();
  });

  it("edits the body inline and reports the change", async () => {
    const { updateNote } = installSkipper();
    const { onChanged } = renderView(note());

    fireEvent.click(screen.getByText("Edit note"));
    const body = await screen.findByPlaceholderText(/What did you learn/);
    fireEvent.change(body, { target: { value: "rewritten wisdom" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(updateNote).toHaveBeenCalledWith(
        "note:abc",
        "rewritten wisdom",
        ["src/terminal.ts"],
        "PTY resize",
      ),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("offers no edit affordance on a captured solution", () => {
    installSkipper();
    renderView(solution());
    expect(screen.queryByText("Edit note")).toBeNull();
  });
});

describe("MemoryRecordView — curation", () => {
  it("casts an up vote and reports the change", async () => {
    const { curate } = installSkipper();
    const { onChanged } = renderView(solution());

    fireEvent.click(screen.getByLabelText("Mark helpful"));
    await waitFor(() => expect(curate).toHaveBeenCalledWith("github:1", "up"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("toggles an existing vote off", async () => {
    const { curate } = installSkipper();
    renderView(solution({ curationVote: "up" }));

    expect(screen.getByLabelText("Mark helpful").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByLabelText("Mark helpful"));
    await waitFor(() => expect(curate).toHaveBeenCalledWith("github:1", null));
  });

  it("switches from up to down in one click", async () => {
    const { curate } = installSkipper();
    renderView(solution({ curationVote: "up" }));

    fireEvent.click(screen.getByLabelText("Mark not helpful"));
    await waitFor(() => expect(curate).toHaveBeenCalledWith("github:1", "down"));
  });

  it("curates notes too", async () => {
    const { curate } = installSkipper();
    renderView(note());

    fireEvent.click(screen.getByLabelText("Mark helpful"));
    await waitFor(() => expect(curate).toHaveBeenCalledWith("note:abc", "up"));
  });

  it("shows the aggregate counters inside the vote buttons", () => {
    installSkipper();
    renderView(solution({ feedback: { up: 3, down: 1 } }));
    expect(screen.getByLabelText("Mark helpful").textContent).toContain("3");
    expect(screen.getByLabelText("Mark not helpful").textContent).toContain("1");
  });
});
