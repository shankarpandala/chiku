import { defineConfig } from "vitest/config";

// Package-local config: without it, vitest walks up and finds the repo root
// vitest.config.ts, whose include only covers scripts/**.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
