import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

/** Tests that need the real records or a credential — run by `npm run test:data` on the Mac only. */
export const DATA_TESTS = [
  "tests/unit/vault-v2.test.ts",
];

export default defineConfig({
  // W68 — compiles the `.svelte.ts` rune modules so they can be unit-tested. Without it `$state` is
  // undefined at import and every such module is reachable only through e2e, which cannot exercise a
  // race. That covered 544 lines across seven modules, three of which exist specifically to make
  // concurrent edits safe. The plugin was already a devDependency; nothing was ever blocking this.
  //
  // W71 CORRECTION — that bought `$state` and only `$state`. Under Node resolution conditions Svelte
  // loads its SERVER build, where `$effect` is compiled away: an `$effect.root` callback never fired,
  // so no effect in any rune module had ever been executed by this suite, and a test asserting one
  // would have passed no matter what the effect did. `resolve.conditions` below fixes the runtime;
  // the effects also need a DOM, so a test that exercises one must carry
  // `// @vitest-environment jsdom` (see tests/unit/draft-sync-effects.test.ts). Without the docblock
  // such a test fails loudly rather than passing vacuously — verified by removing it.
  plugins: [svelte()],
  resolve: {
    // W71 — Svelte resolves to its SERVER build under Node conditions, where `$effect` is compiled
    // away entirely: `$state` works (which is why menu-registry and vault-save were testable) but an
    // `$effect.root` callback never fires, so no effect in any rune module had ever run in this
    // suite. Asking for the browser build is what makes them run; the jsdom environment on its own
    // is not enough, because the condition decides which Svelte runtime is imported.
    conditions: ["browser"],
    alias: {
      // Match vite.config.ts: resolve the cross-app packages to source so Vitest transforms
      // the shared TS directly (a .ts package main under node_modules isn't transformed).
      "@tars/brand": fileURLToPath(new URL("../../packages/brand/index.ts", import.meta.url)),
      "@tars/styles": fileURLToPath(new URL("../../packages/styles", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    // W69 — the unit suite now runs on ubuntu-latest (2 cores), where it takes ~87s against ~29s on
    // the M3. Vitest's 5s default was tuned, implicitly, to this Mac: `access-events-function.test.ts
    // > caps at 200 events` does 205 sequential D1 inserts and times out on the hosted runner while
    // passing locally in a fraction of the budget. Raised globally rather than per-test, because the
    // cause is the machine, not that one test — any other test near the edge would follow it.
    // A genuinely hung test still fails, 20s later instead of 5s.
    testTimeout: 20_000,
    // W69 — these files are not unit tests of code; they are assertions about the REAL committed
    // records, or they need a credential to open them. They run as `npm run test:data` in the gate's
    // `local` job, the only one that checks out records/private and carries the passphrases:
    //
    //   vault-integrity  — the served ciphertext matches records/private (needs PASSPHRASE)
    //   vault-v2         — round-trips against the real committed org key (needs ORG_KEY_PASSPHRASE)
    //   processed-store  — every Alex source has a pre-fold processed artifact
    //   unit-systems     — every convertible analyte in the real vault is mapped or allow-listed
    //   vault-opacity    — no real served filename / dir / vault key embeds a real display name (G1),
    //                      no served blob opens as the roster (G8), every served blob is v2 (G10)
    //
    // The last two exist PRECISELY to fail when real new data arrives, so making them synthetic
    // would delete their purpose. Excluding them here — rather than guarding each with a skipIf —
    // is deliberate: a skip that goes green on a machine without the inputs is indistinguishable
    // from a pass, and that is how vault drift would ship unnoticed.
    exclude: [...DATA_TESTS, "**/node_modules/**"],
    environment: "node",
    // @tinytars/vault and @tinytars/frame ship raw .ts/.svelte with no compiled dist (matching
    // vite.config.ts's own comment on why the cross-app packages need real transformation, not
    // Node's loader) — Vitest externalizes node_modules deps by default, and Node refuses to
    // strip types from a file under node_modules. Inlining routes them through Vitest's own
    // transform pipeline instead.
    server: { deps: { inline: ["@tinytars/vault", "@tinytars/frame"] } },
    // W72 — pin the timezone. Four places in buildUserMessage and two in ranges-prompt derive values
    // from the current date, so an unpinned suite is flaky in the one way that defeats a golden
    // fixture: it trains everyone to regenerate it. 06 ran all 1426 tests under TZ=UTC with no
    // failures before this was applied. `ranges.test.ts`'s TZ sweep asserts a real bug stays fixed,
    // and would pass vacuously if every run were UTC by accident rather than by configuration.
    env: { TZ: "UTC" },
    reporters: ["default"],
    // W72 — `npm run coverage`, not a gate. There is no threshold here on purpose: a coverage bar
    // introduced at the same time as the measurement is a number nobody chose, and the first thing it
    // does is get lowered. Measure, decide what is load-bearing, ratchet later — the same reasoning
    // as W70's axe baseline being a ratchet rather than a zero.
    coverage: {
      provider: "v8",
      // Source only. Tests, fixtures and generated artefacts inflate the denominator and tell you
      // nothing about which shipped code is cold.
      // W75 — the denominator used to flatter us in two ways at once. `src/lib/**/*.svelte` in the
      // EXCLUDE list took out App.svelte (2450 lines) and all 63 components, and — because that
      // pattern also swallows `*.svelte.ts` — every one of the eight rune modules with it, so a
      // module like leaf-regen-queue.svelte.ts was invisible in a report that claimed 251 files.
      // Measuring the UI is the point: App.svelte is where the vault re-key lives.
      //
      // Re-baselined on the honest denominator (2026-08-26, 336 files): lines 53.79%, branches
      // 46.91%, statements 50.88%, functions 52.5%. The flattering denominator read 72.58%/65.71%
      // over 263 files. Nothing got worse; 19 points of it were never being counted.
      include: ["src/**/*.ts", "src/**/*.svelte", "functions/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.d.ts", "scripts/_*.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
    setupFiles: ["./tests/setup.ts"],
  },
});
