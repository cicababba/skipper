import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComposerDraft } from "@skipper/shared";
import { ToastProvider } from "@/lib/toast-context";
import { ToastHost } from "@/components/toast-host";
import { DraftPane } from "./draft-pane";

let connectedAccounts: { key: string; provider: string }[] = [
  { key: "github:1", provider: "github" },
];

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authState: { accounts: connectedAccounts, flows: {} } }),
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
    key: "12",
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
  connectedAccounts = [{ key: "github:1", provider: "github" }];
});

function selfAssignCheckbox(): HTMLInputElement | null {
  return screen.queryByLabelText(/Assign to me/) as HTMLInputElement | null;
}

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
        key: "12",
        number: 12,
        url: "https://github.com/acme/widgets/issues/12",
      })
      .mockResolvedValueOnce({
        ok: true,
        id: "13",
        key: "13",
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

// #274: only GitHub and GitLab resolve a username at create time — for the other
// trackers the option would silently do nothing, so it is not offered at all.
describe("DraftPane self-assign visibility", () => {
  it("offers the self-assign checkbox for a GitHub account", () => {
    installSkipper();
    renderPane();

    expect(selfAssignCheckbox()).toBeTruthy();
  });

  it("hides it for a Bitbucket account", () => {
    connectedAccounts = [{ key: "bitbucket:1", provider: "bitbucket" }];
    installSkipper();
    renderPane();

    expect(selfAssignCheckbox()).toBeNull();
  });

  it("hides it for a Jira account", () => {
    connectedAccounts = [{ key: "jira:9", provider: "jira" }];
    installSkipper();
    renderPane();

    expect(selfAssignCheckbox()).toBeNull();
  });

  it("does not resolve a login for a non-assign-capable account, even with the stored preference on", async () => {
    window.localStorage.setItem("composer.selfAssign", "true");
    connectedAccounts = [{ key: "jira:9", provider: "jira" }];
    const { createIssueOnTracker } = installSkipper();
    const getSelfLogin = (
      window as unknown as { skipper: { composer: { getSelfLogin: ReturnType<typeof vi.fn> } } }
    ).skipper.composer.getSelfLogin;
    renderPane();

    await clickCreate();

    expect(getSelfLogin).not.toHaveBeenCalled();
    expect(createIssueOnTracker.mock.calls[0][0]).not.toHaveProperty("assignees");
  });

  it("resolves and sends the login for a GitHub account", async () => {
    window.localStorage.setItem("composer.selfAssign", "true");
    const { createIssueOnTracker } = installSkipper();
    renderPane();

    await clickCreate();

    expect(createIssueOnTracker.mock.calls[0][0]).toMatchObject({ assignees: ["cicababba"] });
  });
});

// Trackers that do not number their issues announce the display key instead.
describe("DraftPane created refs", () => {
  it("shows the tracker key when the result carries no number", async () => {
    const { createIssueOnTracker } = installSkipper();
    createIssueOnTracker.mockResolvedValue({
      ok: true,
      id: "jira:10101",
      key: "PROJ-123",
      url: "https://acme.atlassian.net/browse/PROJ-123",
    });
    renderPane();

    await clickCreate();

    expect(screen.getByText("Issue PROJ-123 created")).toBeTruthy();
    expect(screen.getByText("PROJ-123 created")).toBeTruthy();
  });
});
