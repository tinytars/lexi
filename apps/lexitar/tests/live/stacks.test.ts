// One real call per feature, against a real model, for every stack MODELS.md offers.
//
// This is the only thing that can prove a shipped example stack actually works: the unit
// conformance test (tests/unit/inference-examples.test.ts) proves the FILE is right — it parses,
// it holds no key, and the capability it declares is the capability the adapter enforces — but it
// answers with a fake server, so it cannot know whether a model is behind that baseUrl at all.
//
// Opt-in, never in CI, because it needs a running server and a key:
//
//   npm run test:live                                                  # every example stack
//   BENCH_LIVE_CONFIG=inference.examples/open-local.json npm run test:live
//
// It is EXCLUDED from `npm run test` rather than skipped inside it, for the reason
// vitest.config.ts gives about the data tests: a skip that goes green without its inputs is
// indistinguishable from a pass. Running this file without BENCH_LIVE=1 fails.
import "../../scripts/load-creds";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProbeCase } from "@pablotech/akesi/benchmarks/model-portability";
import { probesFor } from "../../scripts/model-bench";
import { modelFor } from "../../functions/_lib/inference/resolve";
import { capsFor, parseInferenceConfig, type Feature } from "../../src/lib/model-config";

const DIR = join(import.meta.dirname, "..", "..", "inference.examples");
const FEATURES: Feature[] = ["ranges", "treatmentText", "extract", "document"];

const named = process.env.BENCH_LIVE_CONFIG;
const CONFIGS = named ? [named] : readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => join(DIR, f));

it("refuses to run without BENCH_LIVE=1", () => {
  expect(process.env.BENCH_LIVE, "set BENCH_LIVE=1 — this suite makes real, billable model calls").toBe("1");
});

describe.each(CONFIGS)("%s", (path) => {
  const config = parseInferenceConfig(JSON.parse(readFileSync(path, "utf8")));

  it("serves every feature it declares a capability for", { timeout: 20 * 60_000 }, async () => {
    const { probes, skipped } = await probesFor(FEATURES, config);

    // A feature left out must be left out for a DECLARED missing capability, not because the
    // fixture or the runner quietly dropped it.
    for (const s of skipped) {
      const feature = s.split(" ")[0] as Feature;
      const caps = capsFor(feature, config);
      expect(caps.pdf || caps.vision, `${feature} was skipped but its provider declares a document capability`).toBe(false);
    }
    expect(probes.length + skipped.length).toBe(FEATURES.length);
    // Without this the loop below is vacuous: a config that skipped everything would pass.
    expect(probes.length, "every feature was skipped — this stack was never actually called").toBeGreaterThan(0);

    for (const probe of probes) {
      const { client, model } = modelFor(process.env, probe.feature as Feature, "prod", config);
      const outcome = await runProbeCase(client, model, probe, probe.cases[0]);
      expect(outcome.rejections.join(" | ")).not.toMatch(/model_unsupported/);
      expect(outcome, `${probe.feature} on ${model}`).toMatchObject({ ok: true });
    }
  });
});
