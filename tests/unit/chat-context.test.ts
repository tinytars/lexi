import { describe, it, expect } from "vitest";
import { buildChatContext } from "../../src/lib/chat-context";
import type { Client, MarkerResult } from "../../src/lib/types";

function r(marker: string, date: string, value: number, unit = "mg/dL"): MarkerResult {
  return { marker, group: "Blood", source: "Blood", date, value, unit };
}

function fixture(): Client {
  return {
    displayName: "Pablo",
    dob: "1980-01-01",
    gender: "male",
    watchlist: ["LDL-C", "ApoB"],
    results: [
      r("LDL-C", "2024-01-10", 130),
      r("LDL-C", "2025-06-01", 110),
      r("LDL-C", "2026-06-01", 98),
      r("ApoB", "2026-06-01", 90), // single reading → no delta
    ],
    factors: {
      diseases: [{ id: "d1", date: "2026-06-15", diagnostic: "CAD", icdCodes: ["I25.10"], summary: "CAC 220" }],
      // Repeated name = dose titration over time, not two treatments.
      treatments: [
        { id: "t1", name: "rosuvastatin", dose: "5mg", kind: "drug", start: "2024-02" },
        { id: "t2", name: "rosuvastatin", dose: "10mg", kind: "drug", start: "2025-01" },
      ],
    },
    finding: {
      progression: { latest: "improving", recent: "down", overall: "favorable" },
      criticalRatios: [
        {
          name: "ApoB : ApoA-1",
          numerator: "ApoB",
          denominator: "ApoA-1",
          unit: "",
          meaning: "atherogenic particle balance",
          generalExplanation: "x",
          explanation: "y",
        },
      ],
      disease: [],
      treatment: [],
      doctorConversation: [],
      definitions: [],
      healthMarkers: { recommended: [] },
      generatedAt: "2026-06-20",
      inputsHash: "abc",
    },
  };
}

describe("buildChatContext", () => {
  it("collapses titrated treatment rows to one per name (earliest start, latest dose) + bucket", () => {
    const ctx = buildChatContext(fixture());
    expect(ctx.treatments).toHaveLength(1);
    expect(ctx.treatments[0]).toEqual({ name: "rosuvastatin", dose: "10mg", kind: "drug", start: "2024-02", bucket: "ongoing" });
  });

  it("sums AM+PM ongoing rows into a daily ingredient total, not just one row (W82)", () => {
    const client = fixture();
    const administration = { unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" as const };
    const ingredients = [{ name: "Magnesium", amount: 120, unit: "mg", form: "as magnesium glycinate" }];
    client.factors!.treatments!.push(
      {
        id: "m1", name: "Magnesium (glycinate)", kind: "supplement", start: "2026-08-01", timingPeriod: "AM",
        doseAmount: 1, doseUnit: "capsule", doseFrequency: "day", administration, ingredients,
      },
      {
        id: "m2", name: "Magnesium (glycinate)", kind: "supplement", start: "2026-08-01", timingPeriod: "PM",
        doseAmount: 1, doseUnit: "capsule", doseFrequency: "day", administration, ingredients,
      },
    );
    const ctx = buildChatContext(client);
    const mag = ctx.treatments.find((t) => t.name === "Magnesium (glycinate)");
    // 1 capsule/row * 2 ongoing rows / 1 unitsPerServing = 2 servings/day * 120mg = 240mg/day.
    // Reading only one row (today's bug) would report 120mg/day — half the real total.
    expect(mag?.dailyTotal).toEqual([{ name: "Magnesium", amountPerDay: 240, unit: "mg", form: "as magnesium glycinate" }]);
    // Broken out by timing too — collapseByName alone would have picked one representative row
    // and silently dropped the other half of the regimen.
    expect(mag?.doses).toEqual([
      { timingPeriod: "AM", dose: "1capsule/day" },
      { timingPeriod: "PM", dose: "1capsule/day" },
    ]);
  });

  it("summarizes each marker in the catalog (count, span, latest, watchlisted) — no full series (W16)", () => {
    const ctx = buildChatContext(fixture());
    const ldl = ctx.catalog.find((c) => c.marker === "LDL-C");
    expect(ldl).toMatchObject({ marker: "LDL-C", count: 3, firstDate: "2024-01-10", lastDate: "2026-06-01", watchlisted: true });
    expect(ldl?.latest).toEqual({ value: 98, date: "2026-06-01", unit: "mg/dL" }); // newest only
    // Single-reading markers are catalogued too (deltas omit them).
    const apob = ctx.catalog.find((c) => c.marker === "ApoB");
    expect(apob).toMatchObject({ marker: "ApoB", count: 1, firstDate: "2026-06-01", lastDate: "2026-06-01", watchlisted: true });
    expect(apob?.latest).toEqual({ value: 90, date: "2026-06-01", unit: "mg/dL" });
    // The heavy per-reading dump is gone — specific values are fetched via get_marker_readings.
    expect((ctx as unknown as { readings?: unknown }).readings).toBeUndefined();
  });

  it("includes per-marker deltas (latest vs prior) and omits single-reading markers", () => {
    const ctx = buildChatContext(fixture());
    const ldl = ctx.deltas.find((d) => d.marker === "LDL-C");
    expect(ldl?.latest.value).toBe(98);
    expect(ldl?.vsPrior.abs).toBe(-12); // 98 - 110
    expect(ldl?.vsPrior.direction).toBe("down");
    expect(ldl?.vsBaseline?.abs).toBe(-32); // 98 - 130
    expect(ctx.deltas.find((d) => d.marker === "ApoB")).toBeUndefined();
  });

  it("converts the catalog latest + deltas to the chosen unit system (W14)", () => {
    // US (default): LDL-C stays mg/dL.
    const us = buildChatContext(fixture(), "imperial");
    expect(us.catalog.find((c) => c.marker === "LDL-C")?.latest).toEqual({ value: 98, date: "2026-06-01", unit: "mg/dL" });
    expect(us.deltas.find((d) => d.marker === "LDL-C")?.unit).toBe("mg/dL");

    // SI: LDL-C converts to mmol/L (÷38.67) and the delta abs scales the same way.
    const si = buildChatContext(fixture(), "metric");
    const ldl = si.catalog.find((c) => c.marker === "LDL-C")!;
    expect(ldl.latest.unit).toBe("mmol/L");
    expect(ldl.latest.value).toBeCloseTo(98 / 38.67, 6);
    const dl = si.deltas.find((d) => d.marker === "LDL-C")!;
    expect(dl.unit).toBe("mmol/L");
    expect(dl.vsPrior.abs).toBeCloseTo(-12 / 38.67, 6);
    expect(dl.vsPrior.direction).toBe("down"); // direction is scale-invariant
  });

  it("carries comorbidities with ICD codes and the trimmed Finding slice", () => {
    const ctx = buildChatContext(fixture());
    expect(ctx.diseases[0]).toMatchObject({ diagnostic: "CAD", icdCodes: ["I25.10"], summary: "CAC 220" });
    expect(ctx.patient).toMatchObject({ name: "Pablo", gender: "male" });
    expect(ctx.finding?.progression?.overall).toBe("favorable");
    // criticalRatios trimmed to name + meaning only
    expect(ctx.finding?.criticalRatios).toEqual([
      { name: "ApoB : ApoA-1", meaning: "atherogenic particle balance" },
    ]);
  });
});
