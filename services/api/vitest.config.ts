import { defineConfig } from "vitest/config";

// Without this, vitest walks up and finds the repo-root config (scoped to
// scripts/**). Package tests live in test/.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
