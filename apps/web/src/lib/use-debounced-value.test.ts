import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebouncedValue } from "./use-debounced-value";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDebouncedValue", () => {
  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("prefilled"));
    expect(result.current).toBe("prefilled");
  });

  it("holds the old value until the delay elapses", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v), {
      initialProps: { v: "a" },
    });

    rerender({ v: "ab" });
    expect(result.current).toBe("a");

    act(() => void vi.advanceTimersByTime(299));
    expect(result.current).toBe("a");

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe("ab");
  });

  it("collapses a burst of changes into the last value", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v), {
      initialProps: { v: "" },
    });

    for (const v of ["o", "oa", "oau", "oaut", "oauth"]) {
      rerender({ v });
      act(() => void vi.advanceTimersByTime(100));
    }
    expect(result.current).toBe("");

    act(() => void vi.advanceTimersByTime(300));
    expect(result.current).toBe("oauth");
  });

  it("honours a custom delay", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 1000), {
      initialProps: { v: "a" },
    });

    rerender({ v: "b" });
    act(() => void vi.advanceTimersByTime(500));
    expect(result.current).toBe("a");

    act(() => void vi.advanceTimersByTime(500));
    expect(result.current).toBe("b");
  });

  it("works for non-string values", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    act(() => void vi.advanceTimersByTime(300));
    expect(result.current).toBe(2);
  });
});
