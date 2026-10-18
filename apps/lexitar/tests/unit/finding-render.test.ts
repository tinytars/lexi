import { describe, it, expect } from "vitest";
import { recommendedNamesFromFinding } from "../../src/lib/finding-render";
import type { ClientFinding } from "../../src/lib/types";

function emptyFinding(overrides: Partial<ClientFinding> = {}): ClientFinding {
  return {
    progression: { latest: "", recent: "", overall: "" },
    disease: [],
    treatment: [],
    decisions: { patient: [], ai: [] },
    doctorConversation: [],
    definitions: [],
    healthMarkers: { recommended: [] },
    generatedAt: "2026-06-03T00:00:00.000Z",
    inputsHash: "x",
    ...overrides,
  };
}

describe("recommendedNamesFromFinding", () => {
  it("returns a flat dedup'd list of names across groups", () => {
    const f = emptyFinding({
      healthMarkers: {
        recommended: [
          { group: "A", markers: [{ name: "x", rationale: "r" }, { name: "y", rationale: "r" }] },
          { group: "B", markers: [{ name: "x", rationale: "r" }, { name: "z", rationale: "r" }] },
        ],
      },
    });
    expect(recommendedNamesFromFinding(f)).toEqual(["x", "y", "z"]);
  });

  it("trims whitespace from names", () => {
    const f = emptyFinding({
      healthMarkers: { recommended: [{ group: "A", markers: [{ name: "  foo  ", rationale: "r" }] }] },
    });
    expect(recommendedNamesFromFinding(f)).toEqual(["foo"]);
  });

  it("returns [] when no finding", () => {
    expect(recommendedNamesFromFinding(undefined)).toEqual([]);
  });

  it("skips empty names", () => {
    const f = emptyFinding({
      healthMarkers: {
        recommended: [{ group: "A", markers: [{ name: "  ", rationale: "r" }, { name: "ok", rationale: "r" }] }],
      },
    });
    expect(recommendedNamesFromFinding(f)).toEqual(["ok"]);
  });
});
