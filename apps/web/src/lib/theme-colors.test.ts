import { describe, expect, it } from "vitest";
import { ansiPalette, type AnsiPalette } from "./theme-colors";

const ANSI_KEYS: (keyof AnsiPalette)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

// The chromatic normal colors. `black` and `white` are the background-family
// ANSI colors (black hugs a dark bg, white hugs a light bg) — excluded from the
// contrast check by convention, not readable-text colors.
const NORMAL_KEYS: (keyof AnsiPalette)[] = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
];

const TERMINAL_BG = { dark: "#0F131A", light: "#C4CDD9" } as const;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("ansiPalette", () => {
  it("returns a stable palette per theme", () => {
    expect(ansiPalette("dark")).toBe(ansiPalette("dark"));
    expect(ansiPalette("light")).toBe(ansiPalette("light"));
  });

  it("returns different palettes for dark and light", () => {
    expect(ansiPalette("dark")).not.toEqual(ansiPalette("light"));
  });

  for (const theme of ["dark", "light"] as const) {
    describe(theme, () => {
      const palette = ansiPalette(theme);

      it("has exactly the 16 xterm ANSI keys", () => {
        expect(Object.keys(palette).sort()).toEqual([...ANSI_KEYS].sort());
      });

      it("every value is a 6-digit hex color", () => {
        for (const key of ANSI_KEYS) {
          expect(palette[key]).toMatch(/^#[0-9a-f]{6}$/i);
        }
      });

      it("normal colors clear a lenient 3:1 contrast against the terminal background", () => {
        for (const key of NORMAL_KEYS) {
          expect(contrast(palette[key], TERMINAL_BG[theme])).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});
