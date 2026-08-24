import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Domain tests are pure and run in-process. Tests that touch the database
    // (engine, API) share one SQLite file, so a single fork keeps their writes
    // from racing each other.
    passWithNoTests: true,
    pool: "forks",
    maxWorkers: 1,
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts", "fixtures/**/*.test.ts"],
    setupFiles: ["dotenv/config"],
    coverage: {
      provider: "v8",
      include: ["lib/domain/**", "lib/engine/**"],
      reporter: ["text", "html"],
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
