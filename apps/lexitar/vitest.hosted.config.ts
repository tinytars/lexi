import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// The opt-in suite that sends this app's own queries to the HOSTED database — read-only, no model
// calls, and separate from tests/live/ because the two cost different things and fail for different
// reasons: live makes billable model calls, this one needs a Cloudflare token and a network. Neither
// is in `npm test`, which must stay runnable on a clone with no credential store at all.
//
// Serial, and a timeout per test measured in minutes: every statement is a `wrangler d1 execute`
// subprocess, and running them concurrently would spend the API's rate limit on parallelism nobody
// needs for twenty queries.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/hosted/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 5 * 60_000,
    fileParallelism: false,
    coverage: { ...base.test?.coverage, enabled: false },
  },
});
