import { describe, it, expect } from "vitest";
import { costOf } from "../../scripts/inference-cost";
import { FEATURES, modelId } from "../../src/lib/model-config";

// costOf returns 0 for a model it cannot price, so a family with no row does not fail — it bills
// every run at nothing, and the ingest scripts print a cost that looks like a bargain. This is the
// only place that can notice.
describe("inference cost accounting", () => {
  it("prices every model the shipped config can reach", () => {
    const models = new Set(FEATURES.flatMap((f) => [modelId(f, "prod"), modelId(f, "dev")]));
    for (const model of models) {
      expect(costOf(model, { input_tokens: 1_000_000 }), model).toBeGreaterThan(0);
    }
  });
});
