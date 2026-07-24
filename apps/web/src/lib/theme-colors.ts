export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export type ThemeName = "dark" | "light";

export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const ANSI_DARK: AnsiPalette = {
  black: "#232A34",
  red: "#F07178",
  green: "#7EC699",
  yellow: "#E5C07B",
  blue: "#6C9CFC",
  magenta: "#C678DD",
  cyan: "#56B6C2",
  white: "#D7DDE5",
  brightBlack: "#5C6773",
  brightRed: "#FF8B92",
  brightGreen: "#98E1B0",
  brightYellow: "#F2D08A",
  brightBlue: "#8BB4FF",
  brightMagenta: "#D9A0E8",
  brightCyan: "#72CEDA",
  brightWhite: "#F2F5F9",
};

const ANSI_LIGHT: AnsiPalette = {
  black: "#131A23",
  red: "#B02A37",
  green: "#2E7D42",
  yellow: "#9A6700",
  blue: "#2F5FD7",
  magenta: "#8F3FAF",
  cyan: "#0E7490",
  white: "#CDD5DE",
  brightBlack: "#4B5563",
  brightRed: "#D64550",
  brightGreen: "#3B9B55",
  brightYellow: "#B07D10",
  brightBlue: "#4A7DE8",
  brightMagenta: "#A855C8",
  brightCyan: "#0891B2",
  brightWhite: "#E5E9EF",
};

export function ansiPalette(theme: ThemeName): AnsiPalette {
  return theme === "light" ? ANSI_LIGHT : ANSI_DARK;
}
