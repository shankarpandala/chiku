import { defineConfig } from "vitest/config";

// Root vitest run covers the repo-level scripts (design ingest). Package tests
// run via `pnpm -r run test` — see the root "test" script.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
  },
});
