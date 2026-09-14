import { describe, it, expect } from "vitest";
import {
  quarterKey,
  ratioSeries,
  buildMarkerRatios,
  mergeCriticalRatios,
  isRatioMarkerName,
} from "../../src/lib/marker-ratios";
import { currentZoneStatus } from "@pablotech/akesi-pil/ranges";
import type { Client, CriticalRatio, MarkerResult } from "../../src/lib/types";

function r(marker: string, date: string, value: number, unit = "mg/dL"): MarkerResult {
  return { marker, group: "Blood", source: "Blood", date, value, unit };
}

const TG_HDL: CriticalRatio = {
  name: "Triglycerides : HDL",
  numerator: "Triglycerides",
  denominator: "HDL",
  unit: "",
  meaning: "Insulin-resistance proxy.",
  generalLow: 0,
  generalHigh: 2,
  generalExplanation: "general",
  personalizedLow: 0,
  personalizedHigh: 1.5,
  explanation: "personalized",
};

describe("quarterKey", () => {
  it("buckets a date into year + quarter", () => {
    expect(quarterKey("2026-01-15")).toBe("2026-Q1");
    expect(quarterKey("2026-03-31")).toBe("2026-Q1");
    expect(quarterKey("2026-04-01")).toBe("2026-Q2");
    expect(quarterKey("2025-12-09")).toBe("2025-Q4");
  });
});

describe("ratioSeries", () => {
  it("pairs components by quarter even when drawn on different days", () => {
    const client = {
      results: [
        r("Triglycerides", "2026-02-10", 120),
        r("HDL", "2026-03-25", 60), // same quarter, 6 weeks apart
        r("Triglycerides", "2025-11-01", 180),
        r("HDL", "2025-12-15", 45), // 2025-Q4
      ],
    } as unknown as Client;
    const s = ratioSeries(client, TG_HDL);
    expect(s.map((p) => [p.date, p.value])).toEqual([
      ["2025-12-15", 4], // 180/45, dated at the later component
      ["2026-03-25", 2], // 120/60
    ]);
    expect(s[0].marker).toBe("Triglycerides : HDL");
  });

  it("takes the latest reading within a quarter for each component", () => {
    const client = {
      results: [
        r("Triglycerides", "2026-01-05", 200),
        r("Triglycerides", "2026-03-20", 100), // later in same quarter wins
        r("HDL", "2026-02-02", 50),
      ],
    } as unknown as Client;
    const s = ratioSeries(client, TG_HDL);
    expect(s).toHaveLength(1);
    expect(s[0].value).toBe(2); // 100/50
    expect(s[0].date).toBe("2026-03-20");
  });

  it("skips quarters missing a component or with a zero denominator", () => {
    const client = {
      results: [
        r("Triglycerides", "2026-02-10", 120), // no HDL this quarter
        r("Triglycerides", "2025-11-01", 180),
        r("HDL", "2025-12-15", 0), // zero denominator
      ],
    } as unknown as Client;
    expect(ratioSeries(client, TG_HDL)).toEqual([]);
  });
});

describe("buildMarkerRatios", () => {
  it("returns only ratios with at least one computable point, with an injectable range", () => {
    const client = {
      factorsHash: "abc",
      finding: { generatedAt: "2026-06-01T00:00:00Z", criticalRatios: [TG_HDL] },
      results: [r("Triglycerides", "2026-02-10", 120), r("HDL", "2026-02-12", 60)],
    } as unknown as Client;
    const views = buildMarkerRatios(client);
    expect(views).toHaveLength(1);
    expect(views[0].rows[0].value).toBe(2);
    expect(views[0].range!.high).toBe(1.5);
    expect(views[0].range!.generalHigh).toBe(2);
    expect(views[0].range!.factorsHash).toBe("abc"); // matched -> never stale
    // W30: the ratio's meaning maps to range.meaning (the chart's "What this is:" line),
    // separate from the personalized rationale in explanation.
    expect(views[0].range!.meaning).toBe("Insulin-resistance proxy.");
    expect(views[0].range!.explanation).toBe("personalized");
  });

  it("merge is additive: keeps locked ratios verbatim, appends only new pairs", () => {
    const TC_HDL: CriticalRatio = { ...TG_HDL, name: "Total cholesterol : HDL", numerator: "Total cholesterol" };
    // regen returns a tweaked version of the locked one (same pair) + a brand-new ratio
    const regenTg: CriticalRatio = { ...TG_HDL, personalizedHigh: 2.0, meaning: "REGENERATED" };
    const merged = mergeCriticalRatios([TG_HDL], [regenTg, TC_HDL]);
    expect(merged.map((r) => r.name)).toEqual(["Triglycerides : HDL", "Total cholesterol : HDL"]);
    // locked entry preserved verbatim, NOT overwritten by the regenerated one
    expect(merged[0].personalizedHigh).toBe(1.5);
    expect(merged[0].meaning).toBe("Insulin-resistance proxy.");
  });

  it("dedups by component pair: a renamed same-pair ratio collapses, a new pair is added", () => {
    // same numerator/denominator, different display name + casing → collapses
    const renamed: CriticalRatio = { ...TG_HDL, name: "TG:HDL (atherogenic index)", numerator: "triglycerides", denominator: "hdl" };
    // genuinely different component pair → added
    const apob: CriticalRatio = { ...TG_HDL, name: "ApoB : ApoA-1", numerator: "Apolipoprotein B", denominator: "Apolipoprotein A-1" };
    const merged = mergeCriticalRatios([TG_HDL], [renamed, apob]);
    expect(merged.map((r) => r.name)).toEqual(["Triglycerides : HDL", "ApoB : ApoA-1"]);
  });

  it("drops a ratio whose components never share a quarter", () => {
    const client = {
      finding: { criticalRatios: [TG_HDL] },
      results: [r("Triglycerides", "2026-02-10", 120), r("HDL", "2025-12-12", 60)],
    } as unknown as Client;
    expect(buildMarkerRatios(client)).toEqual([]);
  });
});

// M61 Part B — Marker Ratios union: generated CriticalRatios plus raw ratio-named markers
// already present in client.results.
describe("buildMarkerRatios (raw union)", () => {
  it("includes a raw Ratio-named marker with no matching generated ratio", () => {
    const client = {
      finding: { criticalRatios: [] },
      personalizedRanges: {},
      results: [
        r("BUN/Creatinine Ratio", "2026-01-10", 15),
        r("BUN/Creatinine Ratio", "2026-04-10", 18),
      ],
    } as unknown as Client;
    const views = buildMarkerRatios(client);
    expect(views).toHaveLength(1);
    expect(views[0].ratio.name).toBe("BUN/Creatinine Ratio");
    expect(views[0].rows.map((row) => row.date)).toEqual(["2026-01-10", "2026-04-10"]);
  });

  it("excludes a raw marker whose name matches a generated ratio's name", () => {
    const client = {
      finding: { generatedAt: "2026-06-01T00:00:00Z", criticalRatios: [TG_HDL] },
      results: [
        r("Triglycerides", "2026-02-10", 120),
        r("HDL", "2026-02-12", 60),
        r("Triglycerides : HDL", "2026-02-12", 2),
      ],
    } as unknown as Client;
    const views = buildMarkerRatios(client);
    expect(views).toHaveLength(1);
    expect(views[0].ratio.name).toBe("Triglycerides : HDL");
  });

  it("excludes a raw marker whose component pair matches a generated ratio's numerator/denominator", () => {
    const client = {
      finding: { generatedAt: "2026-06-01T00:00:00Z", criticalRatios: [TG_HDL] },
      results: [
        r("Triglycerides", "2026-02-10", 120),
        r("HDL", "2026-02-12", 60),
        // same pair (case-insensitive), different display name -> collapses into the generated one
        r("triglycerides/hdl Ratio", "2026-02-12", 2),
      ],
    } as unknown as Client;
    const views = buildMarkerRatios(client);
    expect(views).toHaveLength(1);
    expect(views[0].ratio.name).toBe("Triglycerides : HDL");
  });

  it("still returns a RatioView (range: null) for a raw ratio marker with no personalized range yet", () => {
    const client = {
      finding: { criticalRatios: [] },
      personalizedRanges: {},
      results: [r("Omega-6/Omega-3 Ratio", "2026-01-10", 4)],
    } as unknown as Client;
    const views = buildMarkerRatios(client);
    expect(views).toHaveLength(1);
    expect(views[0].range).toBeNull();
    expect(currentZoneStatus(views[0].rows[0].value, views[0].range)).toBe("unknown");
  });

  it("leaves existing generated-only fixtures unchanged (no raw ratio markers in results)", () => {
    const client = {
      factorsHash: "abc",
      finding: { generatedAt: "2026-06-01T00:00:00Z", criticalRatios: [TG_HDL] },
      results: [r("Triglycerides", "2026-02-10", 120), r("HDL", "2026-02-12", 60)],
    } as unknown as Client;
    const views = buildMarkerRatios(client);
    expect(views).toHaveLength(1);
    expect(views[0].ratio.name).toBe("Triglycerides : HDL");
    expect(views[0].range?.high).toBe(1.5);
  });
});

describe("isRatioMarkerName", () => {
  it("matches names containing the word ratio, case-insensitively", () => {
    expect(isRatioMarkerName("BUN/Creatinine Ratio")).toBe(true);
    expect(isRatioMarkerName("Total Cholesterol/HDL ratio")).toBe(true);
    expect(isRatioMarkerName("HDL")).toBe(false);
  });
});
