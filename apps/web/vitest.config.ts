import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Web-scoped override of the root config: component tests (#133) need jsdom and the
// `@/` alias, and the root `include` only matches `.test.ts`. Plain `.test.ts` logic
// tests keep working under jsdom, so this stays a superset of the root behaviour.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
  },
});
