import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ItemAction } from "@/lib/inbox/actions";
import { ActionMenu } from "./action-menu";

const close: ItemAction = { id: "close", kind: "transition", to: "closed" };
const untrack: ItemAction = { id: "untrack", kind: "untrack" };
const replan: ItemAction = { id: "replan", kind: "transition", to: "planning" };
const park: ItemAction = { id: "park", kind: "transition", to: "needs-input" };

function setup(props: Partial<React.ComponentProps<typeof ActionMenu>> = {}) {
  const onSelect = vi.fn();
  // Mirrors the real call site: the menu sits inside a row that navigates on click.
  const onRowClick = vi.fn();
  const view = render(
    <div onClick={onRowClick} data-testid="row">
      <ActionMenu
        actions={props.actions ?? [replan, park]}
        destructive={props.destructive ?? [close, untrack]}
        busyId={props.busyId ?? null}
        busyInMenu={props.busyInMenu ?? false}
        onSelect={props.onSelect ?? onSelect}
      />
    </div>,
  );
  return { onSelect: props.onSelect ?? onSelect, onRowClick, view };
}

const trigger = () => screen.getByRole("button", { name: "More actions" });
const openMenu = () => fireEvent.click(trigger());

// jsdom gives every element a zero rect; place the trigger somewhere sane by default.
function stubRect(rect: Partial<DOMRect>) {
  vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 100,
    bottom: 120,
    left: 500,
    right: 700,
    width: 200,
    height: 20,
    x: 500,
    y: 100,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
}

beforeEach(() => {
  window.innerHeight = 800;
  window.innerWidth = 1200;
  stubRect({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionMenu", () => {
  it("renders nothing when there are no actions at all", () => {
    const { view } = setup({ actions: [], destructive: [] });
    expect(view.container.querySelector("button")).toBeNull();
  });

  it("renders only the kebab until it is opened", () => {
    setup();
    expect(trigger()).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows every action in actionsFor order, destructive last", () => {
    setup();
    openMenu();
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
      "Replan",
      "Park",
      "Close",
      "Untrack",
    ]);
  });

  it("does not navigate into the item when the kebab is clicked", () => {
    const { onRowClick } = setup();
    openMenu();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does not navigate into the item when a menu entry is chosen", () => {
    const { onRowClick } = setup();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Park" }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("dismisses on an outside click without navigating into the item", () => {
    // Regression guard: the dismissing click used to fall through to the row.
    const { onRowClick } = setup();
    openMenu();
    fireEvent.mouseDown(screen.getByTestId("action-menu-backdrop"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    setup();
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when the page scrolls, so it cannot float beside another row", () => {
    setup();
    openMenu();
    fireEvent.scroll(window);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on resize", () => {
    setup();
    openMenu();
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu before invoking onSelect, so window.confirm cannot block it open", async () => {
    let menuMountedAtSelect: boolean | null = null;
    const onSelect = vi.fn(() => {
      menuMountedAtSelect = screen.queryByRole("menu") !== null;
    });
    setup({ onSelect });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Untrack" }));
    // Deferred past a paint via rAF, so it has not fired synchronously.
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(untrack));
    expect(menuMountedAtSelect).toBe(false);
  });

  it("separates destructive entries with a divider", () => {
    const { view } = setup();
    openMenu();
    expect(view.baseElement.querySelectorAll("div.h-px").length).toBe(1);
  });

  it("omits the separator when the menu holds only destructive entries", () => {
    // planning/coding rows: no orphan divider above Close/Untrack.
    const { view } = setup({ actions: [], destructive: [close, untrack] });
    openMenu();
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Close", "Untrack"]);
    expect(view.baseElement.querySelectorAll("div.h-px").length).toBe(0);
  });

  it("omits the separator when the menu holds no destructive entries", () => {
    const { view } = setup({ actions: [replan], destructive: [] });
    openMenu();
    expect(view.baseElement.querySelectorAll("div.h-px").length).toBe(0);
  });

  it("disables the trigger and shows a spinner while a menu action runs", () => {
    setup({ busyId: "untrack", busyInMenu: true });
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(trigger().querySelector(".animate-spin")).toBeTruthy();
  });

  it("disables the trigger without a spinner while the inline primary runs", () => {
    setup({ busyId: "plan", busyInMenu: false });
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    expect(trigger().querySelector(".animate-spin")).toBeNull();
  });

  it("disables every menu entry while an action runs", () => {
    // The trigger is disabled too, so this is defence in depth for an already-open menu.
    const { view } = setup();
    openMenu();
    view.rerender(
      <div>
        <ActionMenu
          actions={[replan, park]}
          destructive={[close, untrack]}
          busyId="replan"
          busyInMenu
          onSelect={vi.fn()}
        />
      </div>,
    );
    for (const entry of screen.queryAllByRole("menuitem")) {
      expect((entry as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("flips above the trigger for rows near the bottom of the viewport", () => {
    // 4 entries + separator ≈ 133px; only 40px of room below.
    stubRect({ top: 740, bottom: 760 });
    const { view } = setup();
    openMenu();
    const menu = view.baseElement.querySelector('[role="menu"]') as HTMLElement;
    const top = parseFloat(menu.style.top);
    expect(top).toBeLessThan(740);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it("keeps the whole menu inside the viewport when it fits below", () => {
    const { view } = setup();
    openMenu();
    const menu = view.baseElement.querySelector('[role="menu"]') as HTMLElement;
    expect(parseFloat(menu.style.top)).toBe(126);
  });

  it("clamps horizontally so it is not clipped at the right edge", () => {
    stubRect({ left: 1150, right: 1195 });
    const { view } = setup();
    openMenu();
    const menu = view.baseElement.querySelector('[role="menu"]') as HTMLElement;
    expect(parseFloat(menu.style.left)).toBe(992); // 1200 - 200 - 8
  });

  it("moves focus into the menu on open and cycles with arrow keys", async () => {
    setup();
    openMenu();
    const items = screen.getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));

    // Wraps from the first entry back to the last.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(items[3]));
  });

  it("exposes the menu to assistive tech via aria-controls/expanded", () => {
    setup();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    openMenu();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(screen.getByRole("menu").id);
  });

  it("toggles closed when the kebab is clicked again", () => {
    setup();
    openMenu();
    expect(screen.getByRole("menu")).toBeTruthy();
    act(() => {
      fireEvent.click(trigger());
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
