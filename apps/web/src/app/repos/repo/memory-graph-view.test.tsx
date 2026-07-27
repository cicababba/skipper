import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MemoryHit, SolutionRecord, StoredPlan } from "@skipper/shared";
import { MemoryGraphView } from "./memory-graph-view";

const REPO = { owner: "acme", name: "rocket" };

function planWith(summary: string, files: string[]): StoredPlan {
  return {
    version: 2,
    itemId: "x",
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

function record(
  itemId: string,
  files: string[],
  overrides: Partial<SolutionRecord> = {},
): SolutionRecord {
  return {
    version: 1,
    itemId,
    repo: REPO,
    title: `title ${itemId}`,
    url: "https://example.test",
    plan: planWith(`summary of ${itemId}`, files),
    capturedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

const RECORDS = [
  record("github:1", ["src/shared.ts"]),
  record("github:2", ["src/shared.ts"]),
  record("note:a", [], {
    kind: "note",
    note: { body: "note body worth reading" },
    plan: undefined,
  }),
];

const hit = (id: string): MemoryHit => ({
  id,
  ref: `${id}.json`,
  score: 1,
  title: id,
  issueKey: "",
  url: "",
  filesTouched: [],
  capturedAt: "2026-07-10T00:00:00.000Z",
});

function installSkipper() {
  const curate = vi.fn().mockResolvedValue({ ok: true });
  (window as unknown as { skipper: unknown }).skipper = { memory: { curate } };
  return { curate };
}

function renderGraph(props: Partial<React.ComponentProps<typeof MemoryGraphView>> = {}) {
  const onFileFilter = vi.fn();
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  const onChanged = vi.fn();
  render(
    <MemoryGraphView
      records={props.records ?? RECORDS}
      hits={props.hits ?? null}
      fileFilter={props.fileFilter ?? null}
      busy={props.busy ?? false}
      onFileFilter={props.onFileFilter ?? onFileFilter}
      onOpen={props.onOpen ?? onOpen}
      onDelete={props.onDelete ?? onDelete}
      onChanged={props.onChanged ?? onChanged}
    />,
  );
  return { onFileFilter, onOpen, onDelete, onChanged };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("MemoryGraphView — rendering", () => {
  it("draws a node per memory and per shared file", () => {
    installSkipper();
    renderGraph();

    expect(screen.getByLabelText("title github:1")).toBeTruthy();
    expect(screen.getByLabelText("title github:2")).toBeTruthy();
    expect(screen.getByLabelText("title note:a")).toBeTruthy();
    expect(screen.getByLabelText("src/shared.ts")).toBeTruthy();
  });

  it("labels file nodes with the basename", () => {
    installSkipper();
    renderGraph();
    expect(screen.getByText("shared.ts")).toBeTruthy();
  });

  it("gives every node finite coordinates", () => {
    installSkipper();
    const { container } = render(
      <MemoryGraphView
        records={RECORDS}
        hits={null}
        fileFilter={null}
        busy={false}
        onFileFilter={vi.fn()}
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    for (const circle of container.querySelectorAll("circle")) {
      expect(Number.isFinite(Number(circle.getAttribute("cx")))).toBe(true);
      expect(Number.isFinite(Number(circle.getAttribute("cy")))).toBe(true);
    }
    const viewBox = container.querySelector("svg")?.getAttribute("viewBox") ?? "";
    expect(viewBox.split(" ").every((n) => Number.isFinite(Number(n)))).toBe(true);
  });

  it("falls back to the empty copy with no records", () => {
    installSkipper();
    renderGraph({ records: [] });
    expect(screen.getByText("No captured solutions for this repo yet.")).toBeTruthy();
  });

  it("dims memories outside the search hits", () => {
    installSkipper();
    renderGraph({ hits: [hit("github:1")] });

    expect(screen.getByLabelText("title github:1").getAttribute("class")).not.toContain("opacity-25");
    expect(screen.getByLabelText("title github:2").getAttribute("class")).toContain("opacity-25");
  });
});

describe("MemoryGraphView — file nodes", () => {
  it("sets the filter when a file node is clicked", () => {
    installSkipper();
    const { onFileFilter } = renderGraph();

    fireEvent.click(screen.getByLabelText("src/shared.ts"));
    expect(onFileFilter).toHaveBeenCalledWith("src/shared.ts");
  });

  it("clears the filter when the active file node is clicked again", () => {
    installSkipper();
    const { onFileFilter } = renderGraph({ fileFilter: "src/shared.ts" });

    fireEvent.click(screen.getByLabelText("src/shared.ts"));
    expect(onFileFilter).toHaveBeenCalledWith(null);
  });
});

describe("MemoryGraphView — side panel", () => {
  it("opens on a memory node click with title and plan summary", () => {
    installSkipper();
    renderGraph();

    expect(screen.queryByText("summary of github:1")).toBeNull();
    fireEvent.click(screen.getByLabelText("title github:1"));
    expect(screen.getByText("summary of github:1")).toBeTruthy();
  });

  it("shows the note body for a note node", () => {
    installSkipper();
    renderGraph();

    fireEvent.click(screen.getByLabelText("title note:a"));
    expect(screen.getByText("note body worth reading")).toBeTruthy();
  });

  it("never shows the diff", () => {
    installSkipper();
    renderGraph({
      records: [record("github:1", ["src/a.ts"], { diff: "diff --git a/x b/x" })],
    });

    fireEvent.click(screen.getByLabelText("title github:1"));
    expect(screen.queryByText(/diff --git/)).toBeNull();
  });

  it("closes again", () => {
    installSkipper();
    renderGraph();

    fireEvent.click(screen.getByLabelText("title github:1"));
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByText("summary of github:1")).toBeNull();
  });

  it("hands the record id to onOpen", () => {
    installSkipper();
    const { onOpen } = renderGraph();

    fireEvent.click(screen.getByLabelText("title github:1"));
    fireEvent.click(screen.getByText("Open"));
    expect(onOpen).toHaveBeenCalledWith("github:1");
  });

  it("hands the record to onDelete", () => {
    installSkipper();
    const { onDelete } = renderGraph();

    fireEvent.click(screen.getByLabelText("title github:1"));
    fireEvent.click(screen.getByLabelText("Delete"));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ itemId: "github:1" }));
  });

  it("curates through the same IPC as the record view and reports the change", async () => {
    const { curate } = installSkipper();
    const { onChanged } = renderGraph();

    fireEvent.click(screen.getByLabelText("title github:1"));
    fireEvent.click(screen.getByLabelText("Mark helpful"));

    await waitFor(() => expect(curate).toHaveBeenCalledWith("github:1", "up"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("toggles an existing vote off and shows the tallies", async () => {
    const { curate } = installSkipper();
    renderGraph({
      records: [
        record("github:1", ["src/a.ts"], { curationVote: "up", feedback: { up: 2, down: 0 } }),
      ],
    });

    fireEvent.click(screen.getByLabelText("title github:1"));
    const up = screen.getByLabelText("Mark helpful");
    expect(up.getAttribute("aria-pressed")).toBe("true");
    expect(up.textContent).toContain("2");

    fireEvent.click(up);
    await waitFor(() => expect(curate).toHaveBeenCalledWith("github:1", null));
  });
});
