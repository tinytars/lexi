import { describe, it, expect } from "vitest";
import { RANGES_MODEL } from "../../src/lib/ranges-config";
import { MODELS } from "../../scripts/inference-config";

// M59 Phase 2 — the web refresh must generate with the SAME model as a prod CLI regen, so a
// web-refreshed Ranges matches one the CLI would produce. Guard the two ids from drifting.
describe("web Ranges-refresh model parity", () => {
  it("RANGES_MODEL equals the CLI prod ranges model", () => {
    expect(RANGES_MODEL).toBe(MODELS.prod.ranges);
  });
});
