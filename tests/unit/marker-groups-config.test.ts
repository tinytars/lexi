import { describe, it, expect } from "vitest";
import { MARKER_GROUPS_MODEL } from "../../src/lib/marker-groups-config";
import { MODELS } from "../../scripts/inference-config";

// W64 — the web refresh must group with the SAME model as a prod CLI run, so the two produce the
// same systems. This was the one inference tier with no config module and no parity test: the
// Function's model was a string literal, and refresh-marker-groups-function.test.ts asserted that
// literal against itself, which cannot fail. Pinned to the CLI's own default here.
describe("web marker-groups refresh model parity", () => {
  it("MARKER_GROUPS_MODEL equals the model generateMarkerGroups defaults to", () => {
    expect(MARKER_GROUPS_MODEL).toBe(MODELS.prod.ranges);
  });
});
