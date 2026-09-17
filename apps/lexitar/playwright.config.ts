import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  // W74 — TRIED TRUE, reverted, and no longer needed. `--shard` partitions by FILE when this is false
  // and by TEST when it is true, and per-test slices looked like the way to stop one 40-test file
  // (shell-nav.spec.ts) from owning a shard. Two shards then failed on assertions rather than on
  // connection errors — the same specs that pass in every file-partitioned run — so something in that
  // file depended on running with its neighbours.
  //
  // Splitting the file seven ways removed the reason to want per-test slices at all: the largest spec
  // file is now 11 tests, so file-level shards balance on their own. The order dependency was never
  // chased down and is still in there somewhere, which is the second reason not to flip this.
  //
  // The third is the constraint below, and it outlives both: true would be unsafe the moment `workers`
  // exceeds 1, whatever the file sizes.
  fullyParallel: false,
  // `fullyParallel: false` only serializes tests *within* one spec file — Playwright still schedules
  // different spec files onto separate worker processes by default (one per ~2 CPUs, so 4 on an
  // 8-core box). But every spec file shares the ONE `wrangler pages dev` server + local D1/R2 below
  // (webServer isn't per-file), and specs that drill in as the shared E2E_CLINICIAN or E2E_SUPPORT
  // identity (tests/e2e/_synthetic.ts) mutate the same account's roster/access rows through the real
  // save API, not a mock. Two files running concurrently against that shared account is a genuine
  // read-modify-write race on shared backend state — a save from one worker can silently lose an edit
  // from another (last-write-wins), or leave a leaf-regen node looking already-fresh because a
  // concurrent worker's write raced the staleness check. That's what surfaced as cross-spec-file
  // flakiness (e.g. shell-nav's M66/M68 "no-double-post" tests asserting a POST count of 0 instead of
  // 1, and editor.spec.ts's Family/Allergies test reading back its own edit reverted) before per-worker
  // synthetic patients (mySynthetic()) removed the shared-*patient* case. Force one worker so the
  // whole suite runs strictly serially against the shared server, matching what `fullyParallel: false`
  // already implied was the intent.
  workers: 1,
  // These specs drive a real wrangler-pages-dev server + WebCrypto ceremonies, so a step can
  // occasionally miss its 30s budget under the pre-push hook's parallel load. One retry absorbs a
  // transient miss without masking a real failure (a genuinely broken test fails both attempts).
  retries: 1,
  // W69 — a workerd death used to read as a mass code regression. 15 of 27 e2e-failing CI runs were
  // `worker process exited unexpectedly (code=null, signal=SIGKILL)` — macOS jetsam killing the
  // server under memory pressure — followed by ~149 `ERR_CONNECTION_REFUSED` assertions that say
  // nothing about the code. Cap the blast radius in CI: a genuine regression rarely breaks 6+ tests
  // at once, so 5 failures is enough to tell "a feature broke" from "the world ended". 0 locally, so
  // a full local run still reports everything.
  //
  // maxFailures is the only first-party mechanism that actually STOPS a run. A globalSetup probe runs
  // before any test and cannot see a death 200s in; `webServer.url` is polled only at startup, never
  // during the run; and a fixture cannot abort a run at all (test.info() has no such verb) — forcing
  // it means process.exit() from a fixture, which corrupts the report and leaks the wrangler tree.
  maxFailures: process.env.CI ? 5 : 0,
  // The reporter is what turns the capped failure into a NAMED one — see _server-death-reporter.ts.
  reporter: [["list"], ["./tests/e2e/_server-death-reporter.ts"]],
  // W44 — account login needs the Pages Functions + D1, so e2e runs against `wrangler pages dev`
  // (real Functions, local D1 seeded from migrations) instead of `vite dev`. The serve script builds,
  // seeds local D1, and serves on 8788 (matching WEBAUTHN_ORIGIN in .dev.vars).
  webServer: {
    command: "bash scripts/e2e-serve.sh",
    url: "http://localhost:8788",
    // Default OFF so Playwright owns the server's lifecycle and tears down its whole process tree on
    // exit — leaving `true` meant a leaked wrangler was reused forever and never reaped, so orphans
    // piled up and pinned the CPU. `test:e2e` frees the port first (scripts/e2e-clean.sh), so a fresh
    // start always succeeds. Set PW_REUSE=1 to keep a warm server across runs for local iteration
    // (then manage it yourself via `npm run e2e:serve`).
    reuseExistingServer: !!process.env.PW_REUSE,
    timeout: 180_000, // build + wrangler cold start
  },
  use: {
    baseURL: "http://localhost:8788",
    // W76 — the suite had no trace, screenshot or video setting at all, which is why the one CI
    // failure that was NOT a server death (`recovery.spec.ts` on run 33072678513, "element is
    // outside of the viewport") could only be theorised about: the shard uploads its wrangler log
    // and nothing else. `retain-on-failure` writes to disk and is discarded on green, so a green
    // run keeps its current cost; the screenshot is what makes a placement bug legible at a glance.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // W69 — cap the renderer heap so Chromium GCs instead of growing until macOS picks WORKERD as the
    // process to kill. The runner is a 16GB machine that sits near its swap limit during a run.
    launchOptions: { args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=512"] },
  },
});
