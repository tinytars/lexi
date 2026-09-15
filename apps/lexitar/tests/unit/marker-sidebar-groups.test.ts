import { describe, it, expect } from "vitest";
import { markerSidebarGroups, markerGroupsPending } from "../../src/lib/marker-sidebar-groups";
import type { Client, MarkerResult } from "../../src/lib/types";

function r(marker: string, date: string, value: number, unit = "mg/dL"): MarkerResult {
  return { marker, group: "Blood", source: "Blood", date, value, unit };
}

describe("markerSidebarGroups", () => {
  it("always includes an Ungrouped row (every marker, flat) before Ratios, even at 0 count", () => {
    const client = {
      finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }] },
      results: [r("ApoB", "2026-01-01", 90)],
      watchlist: [],
    } as unknown as Client;
    const rows = markerSidebarGroups(client);
    expect(rows[0].count).toBe(1);
    expect(rows[0].children!.map((c) => c.key)).toEqual(["ApoB"]);
    expect(rows[1].count).toBe(0);
    expect(rows[1].children).toEqual([]);
  });

  it("counts a raw ratio-named marker into the Ratios row", () => {
    const client = {
      finding: { disease: [] },
      results: [r("BUN/Creatinine Ratio", "2026-01-01", 15)],
      watchlist: [],
    } as unknown as Client;
    const rows = markerSidebarGroups(client);
    expect(rows[1].count).toBe(1);
    expect(rows[1].children).toHaveLength(1);
  });

  it("emits one row per systemOrder entry, in that order, with counts from markerGroups", () => {
    const client = {
      finding: {
        disease: [
          { group: "Cardiovascular Risk", finding: "x" },
          { group: "Metabolic Health", finding: "y" },
        ],
        criticalRatios: [],
      },
      results: [
        r("ApoB", "2026-01-01", 90),
        r("LDL", "2026-01-01", 100),
        r("Glucose", "2026-01-01", 95),
      ],
      watchlist: [],
      markerGroups: {
        groups: [
          { group: "Cardiovascular Risk", markers: ["ApoB", "LDL"] },
          { group: "Metabolic Health", markers: ["Glucose"] },
        ],
      },
    } as unknown as Client;
    const rows = markerSidebarGroups(client);
    expect(rows.map((row) => row.key)).toEqual(["ungrouped", "ratios", "level:Cardiovascular Risk", "level:Metabolic Health"]);
    expect(rows[2].count).toBe(2);
    expect(rows[2].children!.map((c) => c.key).sort()).toEqual(["ApoB", "LDL"]);
    expect(rows[3].count).toBe(1);
    expect(rows[3].children!.map((c) => c.key)).toEqual(["Glucose"]);
  });

  it("threads finding.basis.markerLevels as title on every Levels row, but not on Ungrouped/Ratios", () => {
    const client = {
      finding: {
        disease: [{ group: "Cardiovascular Risk", finding: "x" }],
        basis: { markerLevels: "Personalized levels reflect age, sex, and clinical context." },
      },
      results: [r("ApoB", "2026-01-01", 90)],
      watchlist: [],
    } as unknown as Client;
    const rows = markerSidebarGroups(client);
    expect(rows[0].title).toBeUndefined();
    expect(rows[1].title).toBeUndefined();
    expect(rows[2].title).toBe("Personalized levels reflect age, sex, and clinical context.");
  });

  it("omits an established system with no markers classified into it yet, and surfaces the unclassified marker under a trailing 'Uncategorized' row instead", () => {
    const client = {
      finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }], criticalRatios: [] },
      results: [r("ApoB", "2026-01-01", 90)],
      watchlist: [],
      // no markerGroups yet -> ApoB falls into UNCATEGORIZED, not "Cardiovascular Risk" — the
      // dead (0) "Cardiovascular Risk" row is skipped rather than shown as an empty group, and
      // ApoB stays reachable via "Uncategorized" instead of being stranded.
    } as unknown as Client;
    const rows = markerSidebarGroups(client);
    expect(rows.map((row) => row.key)).toEqual(["ungrouped", "ratios", "level:Not yet categorized"]);
    expect(rows[2].count).toBe(1);
    expect(rows[2].children!.map((c) => c.key)).toEqual(["ApoB"]);
  });
});

describe("markerGroupsPending", () => {
  it("is true when no Finding disease list is established", () => {
    const client = { finding: undefined, results: [], watchlist: [] } as unknown as Client;
    expect(markerGroupsPending(client)).toBe(true);
  });

  it("is true when finding.disease is an empty list", () => {
    const client = { finding: { disease: [] }, results: [], watchlist: [] } as unknown as Client;
    expect(markerGroupsPending(client)).toBe(true);
  });

  it("is false once at least one body-system risk is established", () => {
    const client = {
      finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }] },
      results: [],
      watchlist: [],
    } as unknown as Client;
    expect(markerGroupsPending(client)).toBe(false);
  });
});
