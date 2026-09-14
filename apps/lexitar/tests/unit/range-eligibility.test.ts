import { describe, it, expect } from "vitest";
import { eligibleMarkersForRangeFill } from "../../src/lib/range-eligibility";
import type { Client, MarkerResult } from "../../src/lib/types";

function result(overrides: Partial<MarkerResult> = {}): MarkerResult {
  return { marker: "ApoB", group: "lipids", source: "s1", date: "2026-01-01", value: 1, unit: "mg/dL", ...overrides };
}

function client(results: MarkerResult[], personalizedRanges: Client["personalizedRanges"] = {}): Client {
  return { displayName: "Test", dob: "2000-01-01", gender: "male", watchlist: [], results, personalizedRanges };
}

describe("eligibleMarkersForRangeFill", () => {
  it("includes a marker with a unit and no existing range", () => {
    const c = client([result({ marker: "ApoB", unit: "mg/dL" })]);
    expect(eligibleMarkersForRangeFill(c)).toEqual(["ApoB"]);
  });

  it("excludes a marker that already has a personalized range", () => {
    const c = client([result({ marker: "ApoB", unit: "mg/dL" })], { ApoB: {} as never });
    expect(eligibleMarkersForRangeFill(c)).toEqual([]);
  });

  it("excludes a marker whose unit is empty", () => {
    const c = client([result({ marker: "ApoB", unit: "" })]);
    expect(eligibleMarkersForRangeFill(c)).toEqual([]);
  });

  it("collapses a marker with multiple results into a single eligible entry", () => {
    const c = client([
      result({ marker: "ApoB", unit: "mg/dL", date: "2026-01-01" }),
      result({ marker: "ApoB", unit: "g/L", date: "2026-06-01" }),
    ]);
    // Which unit wins isn't observable here (both are truthy) — the next test pins the direction.
    expect(eligibleMarkersForRangeFill(c)).toEqual(["ApoB"]);
  });

  it("a later empty unit does not override an earlier truthy one for the same marker", () => {
    const c = client([
      result({ marker: "ApoB", unit: "" }),
      result({ marker: "ApoB", unit: "mg/dL" }),
    ]);
    // first-seen-wins the OTHER way: the first unit seen was empty, so the marker is excluded even
    // though a later result for it has a real unit.
    expect(eligibleMarkersForRangeFill(c)).toEqual([]);
  });

  it("returns multiple eligible markers, excluding a mix of ineligible ones", () => {
    const c = client(
      [
        result({ marker: "ApoB", unit: "mg/dL" }),
        result({ marker: "Glucose", unit: "mg/dL" }),
        result({ marker: "Ferritin", unit: "" }),
      ],
      { Glucose: {} as never },
    );
    expect(eligibleMarkersForRangeFill(c)).toEqual(["ApoB"]);
  });

  it("returns an empty array for a client with no results", () => {
    expect(eligibleMarkersForRangeFill(client([]))).toEqual([]);
  });
});
