import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  // File-level shards balance now that no spec exceeds ~11 tests, and true would be unsafe with workers > 1.
  fullyParallel: false,
  // Every file shares one wrangler server and the E2E_CLINICIAN/E2E_SUPPORT D1 rows, so files must not run concurrently.
  workers: 1,
  // No retries: order dependence was hunted with --repeat-each and reverse-order isolation, so a failure is real.
  retries: 0,
  // In CI a workerd death cascades into mass connection failures, so stop after 5; 0 locally reports everything.
  maxFailures: process.env.CI ? 5 : 0,
  // _server-death-reporter.ts names a capped failure as a server death.
  reporter: [["list"], ["./tests/e2e/_server-death-reporter.ts"]],
  // Login needs real Pages Functions + local D1, so e2e runs against `wrangler pages dev` on 8788.
  webServer: {
    command: "bash scripts/e2e-serve.sh",
    url: "http://localhost:8788",
    // Off so Playwright reaps the wrangler tree; PW_REUSE=1 keeps a warm server you manage yourself.
    reuseExistingServer: !!process.env.PW_REUSE,
    timeout: 180_000, // build + wrangler cold start
  },
  use: {
    baseURL: "http://localhost:8788",
    // Written to disk only on failure, so a green run costs nothing.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Cap the renderer heap so Chromium collects garbage instead of pushing the OS to kill workerd.
    launchOptions: { args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=512"] },
  },
});
