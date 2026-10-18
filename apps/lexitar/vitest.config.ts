import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import thresholds from "./coverage-thresholds.json" with { type: "json" };

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
    // There is no credential-bound carve-out any more. tests/unit/vault-v2.test.ts was the only
    // entry in what used to be DATA_TESTS, on the premise that the org key was committed at
    // records/org-key.json — and that premise is the incident this tree is remediating. It now mints
    // a throwaway key, so the whole suite runs against a clone with no credential store, which is
    // the property that makes this repository usable by somebody who is not the operator.
    exclude: ["**/node_modules/**"],
    environment: "node",
    // Hosted 2-core runners are ~3x slower than a dev machine; D1-heavy tests exceed 5s there.
    testTimeout: 20_000,
    // Frame and vault ship raw .ts/.svelte; Node won't strip types under node_modules.
    server: { deps: { inline: ["@tinytars/vault", "@tinytars/frame"] } },
    // Prompt builders derive values from the current date; an unpinned TZ makes goldens flaky.
    // XDG_STATE_HOME is redirected because scripts/access-log.ts spools unflushed org-key uses under
    // it from a process.on("exit") handler — a suite must not append to the operator's real backlog.
    env: { TZ: "UTC", XDG_STATE_HOME: "./.wrangler/tmp/test-state" },
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
