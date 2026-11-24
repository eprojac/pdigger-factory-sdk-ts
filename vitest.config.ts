import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^pdigger-factory-sdk\/viz$/, replacement: src("viz/index.ts") },
      { find: /^pdigger-factory-sdk\/testing$/, replacement: src("testing/index.ts") },
      { find: /^pdigger-factory-sdk$/, replacement: src("index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**", "dist/**"],
    environment: "node",
    testTimeout: 60_000, // only a hang reaches it: no test waits on real time
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
