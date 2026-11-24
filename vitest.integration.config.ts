import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

/** Opt-in integration tests: PDIGGER_FACTORY_URL (read-only against a live unit) and PDIGGER_FACTORY_RECORDINGS. */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^pdigger-factory-sdk\/testing$/, replacement: src("testing/index.ts") },
      { find: /^pdigger-factory-sdk$/, replacement: src("index.ts") },
    ],
  },
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 600_000,
  },
});
