import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "@skipper/shared";
import type {
  IssueSourceCapabilities,
  IssueSourceId,
  LifecycleState,
  OrchestratorState,
  PullRequest,
  TrackedItem,
} from "@skipper/shared";
import { OrchestratorProvider } from "@/lib/orchestrator-context";
import { ToastProvider } from "@/lib/toast-context";
import { ToastHost } from "./toast-host";
import { OrchestratorToasts } from "./orchestrator-toasts";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

const PR = { id: "pr-1", number: 7, url: "https://github.com/octo/repo/pull/7" };

function item(overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "octo/repo", key: "1" },
    codeHost: "github",
    key: "1",
    accountId: "acc",
    repo: { owner: "octo", name: "repo" },
    number: 1,
    title: "fix the topbar",
    url: "https://github.com/octo/repo/issues/1",
    state: "triage",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    transitions: [],
    ...overrides,
  };
}

const CAPABILITIES: Record<IssueSourceId, IssueSourceCapabilities> = {
  github: { closeIssue: true, createIssue: true },
  gitlab: { closeIssue: true, createIssue: true },
  jira: { closeIssue: false, createIssue: true },
  openproject: { closeIssue: true, createIssue: true },
};

function snapshot(items: TrackedItem[], pullRequests: PullRequest[] = []): OrchestratorState {
  return {
    status: "idle",
    intakePaused: false,
    parkedCount: 0,
    queue: { coding: 0, queued: 0, wipLimitPerRepo: 1 },
    items,
    accounts: { acc: { accountId: "acc", status: "idle", issues: [], pullRequests } },
    repoSettings: {},
    projectMappings: {},
    unmappedProjects: [],
    resumeRite: null,
    settings: DEFAULT_ORCHESTRATOR_SETTINGS,
    sourceCapabilities: CAPABILITIES,
  };
}

function at(state: LifecycleState, overrides: Partial<TrackedItem> = {}): OrchestratorState {
  return snapshot([item({ state, ...overrides })]);
}

function installSkipper(initial: OrchestratorState) {
  let emit: (state: OrchestratorState) => void = () => {};
  const openExternal = vi.fn();
  (window as unknown as { skipper: unknown }).skipper = {
    orchestrator: {
      getState: vi.fn().mockResolvedValue(initial),
      onStateChanged: vi.fn((callback: (state: OrchestratorState) => void) => {
        emit = callback;
        return () => {};
      }),
    },
    openExternal,
  };
  return { openExternal, emit: (state: OrchestratorState) => act(() => emit(state)) };
}

async function renderToasts() {
  await act(async () => {
    render(
      <ToastProvider>
        <OrchestratorProvider>
          <OrchestratorToasts />
          <ToastHost />
        </OrchestratorProvider>
      </ToastProvider>,
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("OrchestratorToasts", () => {
  it("shows nothing for the first snapshot, even with an item already at the gate", async () => {
    installSkipper(at("plan-gate", { plan: { confidence: 0.9 } }));
    await renderToasts();

    expect(screen.queryByText("Plan ready for review")).toBeNull();
  });

  it("raises a toast when a plan reaches the gate", async () => {
    const { emit } = installSkipper(at("planning"));
    await renderToasts();

    emit(at("plan-gate", { plan: { confidence: 0.82 } }));

    expect(screen.getByText("Plan ready for review")).toBeTruthy();
    expect(screen.getByText("#1 fix the topbar · confidence 82%")).toBeTruthy();
  });

  it("routes to the item from the action button", async () => {
    const { emit } = installSkipper(at("planning"));
    await renderToasts();

    emit(at("plan-gate"));
    fireEvent.click(screen.getByText("Open item"));

    expect(push).toHaveBeenCalledWith("/inbox/item?id=github%3A1");
  });

  it("opens the PR externally when one is pushed", async () => {
    const { emit, openExternal } = installSkipper(at("human-review"));
    await renderToasts();

    emit(at("pr-open", { pr: PR }));

    expect(screen.getByText("PR opened")).toBeTruthy();
    fireEvent.click(screen.getByText("View PR"));
    expect(openExternal).toHaveBeenCalledWith(PR.url);
  });

  it("does not duplicate a toast when the same snapshot is pushed again", async () => {
    const { emit } = installSkipper(at("planning"));
    await renderToasts();

    const gate = at("plan-gate");
    emit(gate);
    emit(snapshot([item({ state: "plan-gate" })]));

    expect(screen.getAllByText("Plan ready for review")).toHaveLength(1);
  });

  it("shows the needs-input reason", async () => {
    const { emit } = installSkipper(at("coding"));
    await renderToasts();

    emit(
      at("needs-input", {
        transitions: [
          {
            at: "2026-07-01T01:00:00Z",
            from: "coding",
            to: "needs-input",
            actor: "coder",
            reason: "the coder run failed",
          },
        ],
      }),
    );

    expect(screen.getByText("Needs your input")).toBeTruthy();
    expect(screen.getByText("#1 fix the topbar — the coder run failed")).toBeTruthy();
  });

  it("auto-dismisses the PR toast but keeps needs-input on screen", async () => {
    vi.useFakeTimers();
    const { emit } = installSkipper(
      snapshot([
        item({ state: "human-review" }),
        item({ id: "github:2", key: "2", state: "coding" }),
      ]),
    );
    await renderToasts();

    emit(
      snapshot([
        item({ state: "pr-open", pr: PR }),
        item({ id: "github:2", key: "2", state: "needs-input" }),
      ]),
    );

    expect(screen.getByText("PR opened")).toBeTruthy();
    expect(screen.getByText("Needs your input")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText("PR opened")).toBeNull();
    expect(screen.getByText("Needs your input")).toBeTruthy();
  });
});
