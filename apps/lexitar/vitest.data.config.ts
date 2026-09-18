import { defineConfig } from "vitest/config";
import base, { DATA_TESTS } from "./vitest.config";

// Same setup as the default config, only the credential-bound files.
// Not mergeConfig: it concatenates arrays, so `include` would select every file plus these.
export default defineConfig({
  ...base,
  test: { ...base.test, include: DATA_TESTS, exclude: ["**/node_modules/**"] },
});
