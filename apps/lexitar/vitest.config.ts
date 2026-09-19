import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import thresholds from "./coverage-thresholds.json" with { type: "json" };

// Need a credential to run; `npm run test:data`, CI job `lexitar-data`. Excluded rather than skipIf'd:
// a skip that goes green without its inputs is indistinguishable from a pass.
export const DATA_TESTS = [
  "tests/unit/vault-v2.test.ts",
];

export default defineConfig({
  // Compiles `.svelte.ts` rune modules so `$state` exists at import.
  plugins: [svelte()],
  resolve: {
    // Svelte's server build (Node's default) compiles `$effect` away, so effects would never run.
    // Tests that exercise one also need `// @vitest-environment jsdom`.
    conditions: ["browser"],
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    exclude: [...DATA_TESTS, "**/node_modules/**"],
    environment: "node",
    // Hosted 2-core runners are ~3x slower than a dev machine; D1-heavy tests exceed 5s there.
    testTimeout: 20_000,
    // Frame and vault ship raw .ts/.svelte; Node won't strip types under node_modules.
    server: { deps: { inline: ["@tinytars/vault", "@tinytars/frame"] } },
    // Prompt builders derive values from the current date; an unpinned TZ makes goldens flaky.
    env: { TZ: "UTC" },
    reporters: ["default"],
    // Enforced in CI (`npm run coverage`); scripts/coverage-ratchet.ts stops a PR lowering them.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.svelte", "functions/**/*.ts", "scripts/**/*.ts", "server/**/*.ts"],
      exclude: ["**/*.d.ts", "scripts/_*.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds,
    },
    // A stubbed global (fetch, localStorage) must not leak into the next test.
    unstubGlobals: true,
    unstubEnvs: true,
    setupFiles: ["./tests/setup.ts"],
  },
});
