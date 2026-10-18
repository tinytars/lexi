import { describe, it, expect } from "vitest";
import { computeConclusion, isConclusion, conclusionMessage, formatIngredientTotal, roundAmount, dailyTotalsByName } from "../../src/lib/treatment-conclusion";
import type { Administration, Ingredient, TreatmentItem } from "../../src/lib/types";

const admin = (over: Partial<Administration> = {}): Administration =>
  ({ unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day", ...over });
type Row = Pick<TreatmentItem, "doseAmount" | "doseUnit" | "doseFrequency">;
const row = (over: Partial<Row> = {}): Row => ({ doseAmount: 1, doseUnit: "capsule", doseFrequency: "day", ...over });
const fishOil: Ingredient[] = [{ name: "EPA", amount: 500, unit: "mg" }, { name: "DHA", amount: 250, unit: "mg" }];

describe("computeConclusion — normal case", () => {
  it("multiplies ingredient amount by quantity and frequency", () => {
    const r = computeConclusion([row({ doseAmount: 2, doseFrequency: "day" })], admin(), fishOil);
    expect(isConclusion(r)).toBe(true);
    if (!isConclusion(r)) throw new Error("expected a Conclusion");
    expect(r.totalUnitsPerDay).toBe(2);
    expect(r.unit).toBe("capsule");
    expect(r.ingredientTotals).toEqual([
      { name: "EPA", amountPerDay: 1000, unit: "mg", form: undefined },
      { name: "DHA", amountPerDay: 500, unit: "mg", form: undefined },
    ]);
  });

  it("weekly dosing divides down to a per-day rate", () => {
    const r = computeConclusion([row({ doseAmount: 7, doseFrequency: "week" })], admin(), [{ name: "X", amount: 10, unit: "mg" }]);
    if (!isConclusion(r)) throw new Error("expected a Conclusion");
    expect(r.totalUnitsPerDay).toBe(1);
    expect(r.ingredientTotals[0].amountPerDay).toBe(10);
  });
});

describe("computeConclusion — AM+PM summation", () => {
  it("sums two concurrently-ongoing rows of the same medicine, not just one", () => {
    const rows = [row({ doseAmount: 1, doseFrequency: "day" }), row({ doseAmount: 1, doseFrequency: "day" })];
    const r = computeConclusion(rows, admin(), fishOil);
    if (!isConclusion(r)) throw new Error("expected a Conclusion");
    // Undercounting this (treating it as one row) would report 500mg/day EPA instead of 1000mg/day.
    expect(r.totalUnitsPerDay).toBe(2);
    expect(r.ingredientTotals[0]).toEqual({ name: "EPA", amountPerDay: 1000, unit: "mg", form: undefined });
  });
});

describe("dailyTotalsByName", () => {
  const admin: Administration = { unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" };
  const magnesium: Ingredient[] = [{ name: "Magnesium", amount: 120, unit: "mg", form: "as magnesium glycinate" }];
  const today = "2026-09-01";

  it("keys by lowercased name and sums every concurrently-ongoing row of that medicine", () => {
    const items: TreatmentItem[] = [
      { id: "m1", name: "Magnesium (glycinate)", start: "2026-08-01", timingPeriod: "AM", doseAmount: 1, doseUnit: "capsule", doseFrequency: "day", administration: admin, ingredients: magnesium },
      { id: "m2", name: "Magnesium (glycinate)", start: "2026-08-01", timingPeriod: "PM", doseAmount: 1, doseUnit: "capsule", doseFrequency: "day", administration: admin, ingredients: magnesium },
    ];
    const totals = dailyTotalsByName(items, today);
    expect(totals.get("magnesium (glycinate)")).toEqual([{ name: "Magnesium", amountPerDay: 240, unit: "mg", form: "as magnesium glycinate" }]);
  });

  it("omits a medicine with no ongoing rows, even if a past row has full administration/ingredient data", () => {
    const items: TreatmentItem[] = [
      { id: "p1", name: "Old Supplement", start: "2020-01-01", end: "2021-01-01", doseAmount: 1, doseUnit: "capsule", doseFrequency: "day", administration: admin, ingredients: magnesium },
    ];
    expect(dailyTotalsByName(items, today).has("old supplement")).toBe(false);
  });

  it("omits a medicine whose ongoing row has no administration/ingredient data to compute from", () => {
    const items: TreatmentItem[] = [{ id: "r1", name: "rosuvastatin", start: "2024-02-01", dose: "10mg" }];
    expect(dailyTotalsByName(items, today).has("rosuvastatin")).toBe(false);
  });
});

describe("computeConclusion — unitsPerServing != 1", () => {
  it("divides the patient's unit count by the label's serving size before scaling ingredients", () => {
    // Label: "Serving Size: 2 softgels" containing 500mg EPA per serving. Patient takes 4 softgels/day
    // = 2 servings/day = 1000mg/day, not 4 * 500 = 2000mg/day.
    const a = admin({ unit: "softgel", unitsPerServing: 2 });
    const r = computeConclusion([row({ doseAmount: 4, doseUnit: "softgel", doseFrequency: "day" })], a, [{ name: "EPA", amount: 500, unit: "mg" }]);
    if (!isConclusion(r)) throw new Error("expected a Conclusion");
    expect(r.ingredientTotals[0].amountPerDay).toBe(1000);
  });
});

describe("computeConclusion — refusals never fabricate a number", () => {
  it("refuses when turn 2 (administration) never ran", () => {
    const r = computeConclusion([row()], undefined, fishOil);
    expect(isConclusion(r)).toBe(false);
    expect(r).toEqual({ reason: "no-administration" });
    expect(conclusionMessage(r as Exclude<typeof r, { totalUnitsPerDay: number }>)).toBeNull();
  });

  it("refuses when turn 3 (patient dose) never ran", () => {
    const r = computeConclusion([row({ doseAmount: undefined })], admin(), fishOil);
    expect(r).toEqual({ reason: "no-patient-dose" });
  });

  it("refuses when there are no ongoing rows at all", () => {
    const r = computeConclusion([], admin(), fishOil);
    expect(r).toEqual({ reason: "no-patient-dose" });
  });

  it("refuses on a locked-unit mismatch rather than guessing a conversion", () => {
    const r = computeConclusion([row({ doseUnit: "tablet" })], admin({ unit: "capsule" }), fishOil);
    expect(r).toEqual({ reason: "unit-mismatch", patientUnit: "tablet", labelUnit: "capsule" });
  });

  it("unit mismatch is case/whitespace-insensitive", () => {
    const r = computeConclusion([row({ doseUnit: " Capsule " })], admin({ unit: "capsule" }), fishOil);
    expect(isConclusion(r)).toBe(true);
  });

  it("refuses 'as needed' dosing with an explanatory message, not silence", () => {
    const r = computeConclusion([row({ doseFrequency: "as needed" })], admin(), fishOil);
    expect(r).toEqual({ reason: "as-needed" });
    expect(conclusionMessage(r as { reason: "as-needed" })).toBe("Dosed as needed — no daily total.");
  });

  it("refuses if ANY concurrently-ongoing row is as-needed, even if others are scheduled", () => {
    const rows = [row({ doseFrequency: "day" }), row({ doseFrequency: "as needed" })];
    const r = computeConclusion(rows, admin(), fishOil);
    expect(r).toEqual({ reason: "as-needed" });
  });
});

describe("formatIngredientTotal / roundAmount", () => {
  it("rounds to 2 decimal places for display", () => {
    expect(roundAmount(1000 / 3)).toBe(333.33);
  });

  it("formats a total with its ingredient's own unit and form", () => {
    expect(formatIngredientTotal({ name: "Selenium", amountPerDay: 100, unit: "mcg", form: "L-Selenomethionine" }))
      .toBe("100mcg/day Selenium (L-Selenomethionine)");
  });

  it("formats a bare total with no form", () => {
    expect(formatIngredientTotal({ name: "EPA", amountPerDay: 1000, unit: "mg" })).toBe("1000mg/day EPA");
  });
});
