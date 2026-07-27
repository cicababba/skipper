import { describe, expect, it } from "vitest";
import {
  contentBounds,
  fitViewport,
  K_MAX,
  K_MIN,
  panBy,
  zoomAt,
  type Viewport,
} from "./graph-viewport";

const toWorld = (vp: Viewport, x: number, y: number) => ({
  x: (x - vp.x) / vp.k,
  y: (y - vp.y) / vp.k,
});

describe("contentBounds", () => {
  it("returns null for no points", () => {
    expect(contentBounds([])).toBeNull();
  });

  it("wraps every point", () => {
    expect(
      contentBounds([
        { x: -10, y: 5 },
        { x: 30, y: -2 },
        { x: 0, y: 40 },
      ]),
    ).toEqual({
      minX: -10,
      minY: -2,
      maxX: 30,
      maxY: 40,
    });
  });

  it("treats missing coordinates as the origin", () => {
    expect(contentBounds([{}, { x: 4, y: 4 }])).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 4 });
  });

  it("collapses to a point for a single node", () => {
    expect(contentBounds([{ x: 3, y: 7 }])).toEqual({ minX: 3, minY: 7, maxX: 3, maxY: 7 });
  });

  it("ignores non-finite coordinates", () => {
    expect(
      contentBounds([
        { x: NaN, y: 1 },
        { x: 2, y: 2 },
      ]),
    ).toEqual({
      minX: 2,
      minY: 2,
      maxX: 2,
      maxY: 2,
    });
    expect(contentBounds([{ x: Infinity, y: Infinity }])).toBeNull();
  });
});

describe("fitViewport", () => {
  it("centers the content in the container", () => {
    const vp = fitViewport(
      { minX: -100, minY: -50, maxX: 100, maxY: 50 },
      {
        width: 800,
        height: 400,
      },
    );
    expect(toWorld(vp, 400, 200)).toEqual({ x: 0, y: 0 });
  });

  it("scales so the padded content fits on the tighter axis", () => {
    const vp = fitViewport(
      { minX: 0, minY: 0, maxX: 800, maxY: 100 },
      { width: 480, height: 480 },
      40,
    );
    expect(vp.k).toBeCloseTo(0.5, 5);
    expect(toWorld(vp, 40, 240)).toEqual({ x: 0, y: 50 });
  });

  it("never fit-zooms in past 1.5", () => {
    expect(
      fitViewport({ minX: -5, minY: -5, maxX: 5, maxY: 5 }, { width: 800, height: 480 }).k,
    ).toBe(1.5);
  });

  it("clamps at the lower end for huge content", () => {
    expect(
      fitViewport({ minX: 0, minY: 0, maxX: 100_000, maxY: 100_000 }, { width: 800, height: 480 })
        .k,
    ).toBe(K_MIN);
  });

  it("falls back to identity without bounds", () => {
    expect(fitViewport(null, { width: 800, height: 480 })).toEqual({ x: 0, y: 0, k: 1 });
  });

  it("falls back to identity on a zero-sized container", () => {
    const bounds = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
    expect(fitViewport(bounds, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, k: 1 });
    expect(fitViewport(bounds, { width: 800, height: 0 })).toEqual({ x: 0, y: 0, k: 1 });
  });

  it("falls back to identity on degenerate bounds", () => {
    expect(
      fitViewport({ minX: 3, minY: 3, maxX: 3, maxY: 3 }, { width: 800, height: 480 }),
    ).toEqual({ x: 0, y: 0, k: 1 });
  });

  it("still fits content that is flat on one axis", () => {
    const vp = fitViewport(
      { minX: 0, minY: 10, maxX: 200, maxY: 10 },
      {
        width: 240,
        height: 480,
      },
    );
    expect(vp.k).toBeCloseTo(0.8, 5);
    expect(toWorld(vp, 120, 240)).toEqual({ x: 100, y: 10 });
  });
});

describe("zoomAt", () => {
  const vp: Viewport = { x: 30, y: -20, k: 0.8 };

  it("keeps the world point under the cursor fixed", () => {
    const cursor = { x: 250, y: 140 };
    const before = toWorld(vp, cursor.x, cursor.y);
    const after = toWorld(zoomAt(vp, cursor, 1.4), cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("keeps the anchor fixed when zooming out too", () => {
    const cursor = { x: 12, y: 400 };
    const before = toWorld(vp, cursor.x, cursor.y);
    const after = toWorld(zoomAt(vp, cursor, 1 / 1.4), cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("multiplies the scale", () => {
    expect(zoomAt(vp, { x: 0, y: 0 }, 2).k).toBeCloseTo(1.6, 6);
  });

  it("clamps at the maximum and stays consistent with the effective factor", () => {
    const cursor = { x: 100, y: 100 };
    const zoomed = zoomAt({ x: 0, y: 0, k: 4 }, cursor, 10);
    expect(zoomed.k).toBe(K_MAX);
    const before = toWorld({ x: 0, y: 0, k: 4 }, cursor.x, cursor.y);
    const after = toWorld(zoomed, cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("clamps at the minimum", () => {
    expect(zoomAt({ x: 5, y: 5, k: 0.25 }, { x: 0, y: 0 }, 0.01).k).toBe(K_MIN);
  });
});

describe("panBy", () => {
  it("translates without touching the scale", () => {
    expect(panBy({ x: 10, y: 20, k: 2 }, -4, 6)).toEqual({ x: 6, y: 26, k: 2 });
  });
});
