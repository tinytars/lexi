import { describe, it, expect } from "vitest";
import { loweredThresholds } from "../../scripts/coverage-ratchet";
import thresholds from "../../coverage-thresholds.json" with { type: "json" };

const base = { lines: 50, "src/lib/**": { lines: 60, branches: 40 } };

describe("loweredThresholds", () => {
  it("allows equal or higher thresholds, and new keys", () => {
    expect(loweredThresholds(base, base)).toEqual([]);
    expect(loweredThresholds(base, { lines: 51, "src/lib/**": { lines: 60, branches: 45 }, functions: 10 })).toEqual([]);
  });

  it("reports a lowered global and a lowered per-directory threshold", () => {
    expect(loweredThresholds(base, { lines: 49, "src/lib/**": { lines: 60, branches: 39 } })).toEqual([
      "lines: 50 -> 49",
      "src/lib/** branches: 40 -> 39",
    ]);
  });

  it("treats a removed threshold as lowered", () => {
    expect(loweredThresholds(base, { lines: 50 })).toEqual(["src/lib/** lines: 60 -> removed", "src/lib/** branches: 40 -> removed"]);
  });

  it("accepts the committed thresholds file", () => {
    expect(loweredThresholds(thresholds, thresholds)).toEqual([]);
  });
});
