import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // apps/web is the only package using the "@/" path alias (its tsconfig paths
  // entry); vitest has no Next.js resolver, so it needs the same mapping to load
  // a component that imports from @/lib.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // Cwd-relative so the same config works from the root AND from each
    // package's own `vitest run` (turbo runs tests per package; root-anchored
    // globs match nothing from a package cwd).
    include: ["**/src/**/*.test.ts", "**/tests/**/*.test.ts"],
    // .next/standalone re-copies apps/web sources — without this every web
    // test runs twice (and against stale build output).
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
  },
});
