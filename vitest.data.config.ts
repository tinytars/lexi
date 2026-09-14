import { defineConfig } from "vitest/config";
import base, { DATA_TESTS } from "./vitest.config";

// W69 — the half of the suite that needs the real records or a credential.
//
// Same plugins, aliases and setup as the default config; only the file list differs. Split by INPUT,
// not by subject matter: these are the ones that cannot run without
// ~/.claude/infra/cloud/credentials or records/private.
//
//   npm run test       → everything else, runs anywhere (the hosted job)
//   npm run test:data  → these, in the `local` job, which is the only one that checks out
//                        records/private and holds the passphrases as Actions secrets
//
// Both are required checks, so coverage is partitioned, not reduced.
//
// NOT mergeConfig: it CONCATENATES array options, so merging an `include` onto the base one selects
// every file plus these — which looks like it works, because the run is green.
export default defineConfig({
  ...base,
  test: { ...base.test, include: DATA_TESTS, exclude: ["**/node_modules/**"] },
});
