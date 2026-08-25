import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

// `npm run test:live` passes --mode live. Cross-platform: setting an env var
// inline in an npm script does not work on Windows cmd.
const isLive = process.argv.includes("live");

export default defineConfig({
  test: {
    // Domain tests are pure and run in-process. Tests that touch the database
    // (engine, API) share one SQLite file, so a single worker keeps their writes
    // from racing each other.
    passWithNoTests: true,
    pool: "forks",
    maxWorkers: 1,
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
    // *.live.test.ts calls the real Gemini API. Excluded by default so `npm run
    // check` needs no key and no network; run them with `npm run test:live`.
    exclude: [
      "node_modules/**",
      "lib/generated/**",
      ".next/**",
      ...(isLive ? [] : ["**/*.live.test.ts"]),
    ],
    setupFiles: ["dotenv/config"],
    coverage: {
      provider: "v8",
      // The code that must never be wrong.
      include: ["lib/domain/**", "lib/engine/**"],
      exclude: ["**/*.test.ts"],
      reporter: ["text", "html"],
    },
  },
  resolve: {
    // Mirrors tsconfig paths -- longest prefix first, so "@/domain/x" is not
    // swallowed by the bare "@" alias.
    alias: [
      { find: /^@\/domain\//, replacement: path.join(root, "lib/domain/") },
      { find: /^@\/engine\//, replacement: path.join(root, "lib/engine/") },
      { find: /^@\/llm\//, replacement: path.join(root, "lib/llm/") },
      { find: /^@\/instagram\//, replacement: path.join(root, "lib/instagram/") },
      { find: /^@\/config\//, replacement: path.join(root, "lib/config/") },
      { find: /^@\/api\//, replacement: path.join(root, "lib/api/") },
      { find: /^@\/tests\//, replacement: path.join(root, "tests/") },
      { find: /^@\/db$/, replacement: path.join(root, "lib/db.ts") },
      { find: /^@\//, replacement: `${root}/` },
    ],
  },
});
