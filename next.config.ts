
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // fs-ext is a native addon used only by the snapshot store (server only, reached through runtime-access.ts).
  // It must be loaded with Node's require, not bundled. Verified by the M2-1 browser restart check, not assumed.
  serverExternalPackages: ["fs-ext"],
  partialPrefetching: true,
  // Lets src/app/global-not-found.tsx replace the default 404 even though there are two root layouts.
  experimental: { globalNotFound: true },
  turbopack: {
    root: process.cwd(),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
