// Zoom/pan viewport math for the memory graph (#255, slice 3). Pure: the view
// layer owns the events, this owns the arithmetic. Screen = world·k + (x, y).

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const K_MIN = 0.2;
export const K_MAX = 5;

/** Fitting never zooms past this: a two-node graph filling the canvas looks broken. */
const K_FIT_MAX = 1.5;

const IDENTITY: Viewport = { x: 0, y: 0, k: 1 };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function contentBounds(points: Array<{ x?: number; y?: number }>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

export function fitViewport(bounds: Bounds | null, size: Size, padding = 40): Viewport {
  if (!bounds) return IDENTITY;
  if (!(size.width > 0) || !(size.height > 0)) return IDENTITY;

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width <= 0 && height <= 0) return IDENTITY;

  const innerWidth = Math.max(size.width - padding * 2, 1);
  const innerHeight = Math.max(size.height - padding * 2, 1);
  const scales: number[] = [];
  if (width > 0) scales.push(innerWidth / width);
  if (height > 0) scales.push(innerHeight / height);

  const k = clamp(Math.min(...scales), K_MIN, K_FIT_MAX);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return { x: size.width / 2 - centerX * k, y: size.height / 2 - centerY * k, k };
}

/** Zoom about a container-space point: the world point under it stays put. */
export function zoomAt(
  viewport: Viewport,
  point: { x: number; y: number },
  factor: number,
): Viewport {
  const k = clamp(viewport.k * factor, K_MIN, K_MAX);
  const effective = viewport.k === 0 ? 1 : k / viewport.k;
  return {
    x: point.x - (point.x - viewport.x) * effective,
    y: point.y - (point.y - viewport.y) * effective,
    k,
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { x: viewport.x + dx, y: viewport.y + dy, k: viewport.k };
}
