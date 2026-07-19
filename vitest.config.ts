import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // node:sqlite (tests/store-d1-sql.test.ts) is flagged on Node 22, which CI pins, and the
    // flag is an accepted no-op on Node 24. Passing it unconditionally keeps one command
    // green on both.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
    },
  },
});
