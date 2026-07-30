import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComposerDraft } from "@skipper/shared";
import { ToastProvider } from "@/lib/toast-context";
import { ToastHost } from "@/components/toast-host";
import { DraftPane } from "./draft-pane";

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authState: { accounts: [{ key: "github:1", provider: "github" }], flows: {} } }),
}));

vi.mock("@/lib/orchestrator-context", () => ({
  useOrchestrator: () => ({ state: { items: [], accounts: {} } }),
}));

const REPO = { owner: "acme", name: "widgets" };

const DRAFT: ComposerDraft = {
  issues: [
    {
      title: "web:fix: the topbar jumps",
      body: "It shifts by a pixel on hover.",
      acceptanceCriteria: [],
      labels: [],
    },
  ],
  relations: [],
};

function installSkipper() {
  const openExternal = vi.fn();
  const createIssueOnTracker = vi.fn().mockResolvedValue({
    ok: true,
    id: "12",
    number: 12,
    url: "https://github.com/acme/widgets/issues/12",
  });
  (window as unknown as { skipper: unknown }).skipper = {
    composer: { getSelfLogin: vi.fn().mockResolvedValue({ login: "cicababba" }) },
    orchestrator: { createIssueOnTracker },
    openExternal,
  };
  return { openExternal, createIssueOnTracker };
}

function renderPane(draft: ComposerDraft = DRAFT) {
  render(
    <ToastProvider>
      <DraftPane repo={REPO} draft={draft} busy={false} onEdit={vi.fn()} onBlur={vi.fn()} />
      <ToastHost />
    </ToastProvider>,
  );
}

async function clickCreate() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
  window.localStorage.clear();
});

describe("DraftPane toasts", () => {
  it("announces a created issue with a link to the tracker", async () => {
    const { openExternal } = installSkipper();
    renderPane();

    await clickCreate();

    expect(screen.getByText("Issue #12 created")).toBeTruthy();
    expect(screen.getByText("web:fix: the topbar jumps")).toBeTruthy();

    fireEvent.click(screen.getByText("Open on the tracker"));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/widgets/issues/12");
  });

  it("raises one toast per created issue", async () => {
    const { createIssueOnTracker } = installSkipper();
    createIssueOnTracker
      .mockResolvedValueOnce({
        ok: true,
        id: "12",
        number: 12,
        url: "https://github.com/acme/widgets/issues/12",
      })
      .mockResolvedValueOnce({
        ok: true,
        id: "13",
        number: 13,
        url: "https://github.com/acme/widgets/issues/13",
      });
    renderPane({
      issues: [DRAFT.issues[0], { ...DRAFT.issues[0], title: "web:fix: the sidebar jumps" }],
      relations: [],
    });

    await clickCreate();

    expect(screen.getByText("Issue #12 created")).toBeTruthy();
    expect(screen.getByText("Issue #13 created")).toBeTruthy();
  });

  it("stays quiet when the tracker rejects the issue", async () => {
    const { createIssueOnTracker } = installSkipper();
    createIssueOnTracker.mockResolvedValue({ ok: false, error: "boom" });
    renderPane();

    await clickCreate();

    expect(screen.queryByText("Issue #12 created")).toBeNull();
    expect(screen.getByText("Creation failed")).toBeTruthy();
  });
});
