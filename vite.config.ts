import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";

// Everything is inlined into one index.html so the built app can be opened
// straight from disk (file://) or hosted on any static host. No backend.
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: { target: "es2022" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
