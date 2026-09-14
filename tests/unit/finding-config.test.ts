import { describe, it, expect } from "vitest";
import { FINDING_MODEL } from "../../src/lib/finding-config";
import { MODELS } from "../../scripts/inference-config";

// W15/3b.2 — the web refresh must generate with the SAME model as a prod CLI regen, so a
// web-refreshed Finding matches one the CLI would produce. Guard the two ids from drifting.
describe("web Finding-refresh model parity", () => {
  it("FINDING_MODEL equals the CLI prod finding model", () => {
    expect(FINDING_MODEL).toBe(MODELS.prod.finding);
  });
});
