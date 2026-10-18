import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// The opt-in suite that makes real model calls. Same setup, a different file set, and no timeout
// worth the name: a self-hosted model on a small GPU answers in minutes, not seconds.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["tests/live/**/*.test.ts"], exclude: ["**/node_modules/**"], testTimeout: 20 * 60_000 },
});
