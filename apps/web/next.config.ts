import type { NextConfig } from "next";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("./package.json") as { version: string };

const nextConfig: NextConfig = {
  // Static export (#208): the desktop app serves these files over an app://
  // custom protocol instead of forking a Next.js server.
  output: "export",
  // Inject the app version at build time so UI surfaces (sidebar footer,
  // settings about block, etc.) always reflect what was actually shipped.
  // Bumping the version in package.json is the single source of truth.
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  devIndicators: false,
};

export default nextConfig;
