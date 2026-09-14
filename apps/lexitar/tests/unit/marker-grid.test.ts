import { describe, it, expect } from "vitest";
import { flatMarkers, markerSystemIndex } from "../../src/lib/marker-grid";
import type { Client, MarkerResult, PersonalizedRange } from "../../src/lib/types";

const reading = (marker: string, over: Partial<MarkerResult> = {}): MarkerResult => ({
  marker, group: "Lipids", source: "Blood", date: "2026-01-01", value: 1, unit: "x", ...over,
});

const range = (over: Partial<PersonalizedRange>): PersonalizedRange =>
  ({ unit: "x", explanation: "", ...over } as PersonalizedRange);

function client(overrides: Partial<Client> = {}): Client {
  return { displayName: "T", dob: "1990-01-01", gender: "male", watchlist: [], results: [], ...overrides };
}

describe("flatMarkers", () => {
  // W65 — the decision the removed `windowYears` parameter records: the window is a per-chart zoom,
  // so a marker last measured years ago is still in the record and still listed. Reintroducing a
  // set filter (rather than a series filter) fails here, which is the point — at the default 1-year
  // window it would have dropped 23 of Pablo's 372 markers on load while the sidebar listed all 372.
  it("lists a marker whose only reading predates any plausible window", () => {
    const c = client({
      results: [
        reading("ApoB", { date: "2026-06-01", value: 100 }),
        reading("Ferritin", { date: "2009-03-14", value: 42 }),
      ],
    });
    expect(flatMarkers(c).map((m) => m.name)).toContain("Ferritin");
  });


  it("returns one Marker per distinct name, sorted, with rows/source/flags resolved", () => {
    const c = client({
      watchlist: ["ApoB"],
      recommended: ["Glucose"],
      results: [
        reading("ApoB", { date: "2025-01-01", value: 100 }),
        reading("ApoB", { date: "2026-01-01", value: 76 }),
        reading("Glucose", { group: "Metabolic", source: "Blood" }),
      ],
    });
    const flat = flatMarkers(c);
    expect(flat.map((m) => m.name)).toEqual(["ApoB", "Glucose"]);
    const apob = flat[0];
    expect(apob.rows).toHaveLength(2);
    expect(apob.rows[0].date).toBe("2025-01-01"); // rows sorted oldest-first
    expect(apob.source).toBe("Blood");
    expect(apob.group).toBe("Lipids");
    expect(apob.highlighted).toBe(true);
    expect(apob.recommended).toBe(false);
    expect(flat[1].recommended).toBe(true);
    expect(flat[1].highlighted).toBe(false);
  });

  it("sorts by descending concern (danger, warn, safe, unknown), then name within each", () => {
    const c = client({
      personalizedRanges: {
        Danger: range({ low: 10, high: 20, generalLow: 5, generalHigh: 25 }),
        Zebra: range({ low: 10, high: 20, generalLow: 5, generalHigh: 25 }), // also danger
        Safe: range({ low: 10, high: 20 }),
      },
      results: [
        reading("Danger", { value: 30 }), // beyond general -> danger
        reading("Zebra", { value: 1 }), // beyond general -> danger
        reading("Safe", { value: 15 }), // within personalized -> safe
        reading("NoRange", { value: 999 }), // no personalizedRanges entry -> unknown
      ],
    });
    const flat = flatMarkers(c);
    expect(flat.map((m) => m.name)).toEqual(["Danger", "Zebra", "Safe", "NoRange"]);
    expect(flat.map((m) => m.status)).toEqual(["danger", "danger", "safe", "unknown"]);
  });
});

describe("markerSystemIndex", () => {
  it("maps marker name → body system, first placement wins", () => {
    const c = client({
      markerGroups: {
        groups: [
          { group: "Cardiovascular Risk", markers: ["ApoB", "Aortic root"] },
          { group: "Body Composition", markers: ["Android % Fat", "ApoB"] }, // ApoB already placed
        ],
        markerGroupsHash: "h", generatedAt: "2026-01-01T00:00:00.000Z", generatedBy: { mode: "prod", model: "m" },
      },
    });
    const idx = markerSystemIndex(c);
    expect(idx.get("ApoB")).toBe("Cardiovascular Risk");
    expect(idx.get("Aortic root")).toBe("Cardiovascular Risk");
    expect(idx.get("Android % Fat")).toBe("Body Composition");
  });

  it("is empty when no grouping exists yet", () => {
    expect(markerSystemIndex(client()).size).toBe(0);
  });
});
