import { describe, it, expect } from "vitest";
import { fmtNum, fmtRangeStr, displayScaleFor, convertForDisplay } from "../../src/lib/units";

describe("fmtNum", () => {
  it("drops decimals at/above 100, one at/above 10, two below", () => {
    expect(fmtNum(150)).toBe("150");
    expect(fmtNum(15)).toBe("15.0");
    expect(fmtNum(1.5)).toBe("1.50");
    expect(fmtNum(-150)).toBe("-150");
    expect(fmtNum(-1.5)).toBe("-1.50");
  });
});

describe("fmtRangeStr", () => {
  it("renders both bounds with the unit suffix", () => {
    expect(fmtRangeStr(10, 20, "mg/dL")).toBe("10–20 mg/dL");
  });
  it("renders a one-sided bound", () => {
    expect(fmtRangeStr(null, 5, "mg/dL")).toBe("< 5 mg/dL");
    expect(fmtRangeStr(2, null, "mg/dL")).toBe("> 2 mg/dL");
  });
  it("renders titers as 1:n with no unit suffix", () => {
    expect(fmtRangeStr(80, 160, "titer")).toBe("1:80–1:160");
  });
  it("returns null when both bounds are absent", () => {
    expect(fmtRangeStr(null, null, "x")).toBeNull();
  });
});

// displayScaleFor(marker, baseUnit, dataMaxAbs, system) — a non-analyte marker name
// exercises the physical branch; an analyte name exercises the molar branch.
describe("displayScaleFor — physical", () => {
  it("keeps grams under 1000 as g (metric/SI)", () => {
    expect(displayScaleFor("Android Total mass", "g", 500, "metric")).toEqual({ scale: 1, unit: "g" });
  });
  it("promotes grams over 1000 to kg (metric/SI)", () => {
    expect(displayScaleFor("Android Total mass", "g", 2000, "metric")).toEqual({ scale: 0.001, unit: "kg" });
  });
  it("chains the kg promotion into the imperial/US lb conversion", () => {
    const r = displayScaleFor("Android Total mass", "g", 2000, "imperial");
    expect(r.unit).toBe("lb");
    expect(r.scale).toBeCloseTo(0.001 * 2.20462, 10);
  });
  it("converts cm to in under US", () => {
    const r = displayScaleFor("Height", "cm", 10, "imperial");
    expect(r.unit).toBe("in");
    expect(r.scale).toBeCloseTo(0.393701, 10);
  });
  it("converts a non-analyte g/L marker to mg/dL under US (dimensional ×100)", () => {
    expect(displayScaleFor("Gamma Globulin, Serum", "g/L", 10, "imperial")).toEqual({ scale: 100, unit: "mg/dL" });
    expect(displayScaleFor("Gamma Globulin, Serum", "g/L", 10, "metric")).toEqual({ scale: 1, unit: "g/L" });
  });
  // M93 — PHYSICAL_NO_CONVERT: VAT mass is reported in grams in US practice too (owner-confirmed),
  // so the generic g→lb table must be suppressed for this marker even under "imperial".
  it("does not convert Visceral adipose tissue mass to lb under US", () => {
    expect(displayScaleFor("Visceral adipose tissue mass", "g", 500, "imperial")).toEqual({ scale: 1, unit: "g" });
  });
  it("still converts an unrelated marker's grams to lb under US (suppression is marker-scoped)", () => {
    expect(displayScaleFor("Android Total mass", "g", 500, "imperial")).toEqual({ scale: 0.00220462, unit: "lb" });
  });
  // M93 — eGFR's two source-format unit-string variants canonicalize to one displayed label.
  it("canonicalizes cosmetic eGFR unit-string variants to one label", () => {
    expect(displayScaleFor("eGFR / Cystatin C", "mL/min /1.73m2", 90, "imperial").unit).toBe("mL/min/1.73m²");
    expect(displayScaleFor("eGFR - Estimated Glomerular Filtration Rate (Non-African Am)", "mL/min per 1.73 m2", 90, "metric").unit).toBe("mL/min/1.73m²");
  });
  // M93 — universal compound units (no US-customary form in routine clinical use) pass through
  // unconverted under BOTH systems, same as before, but now explicitly classified rather than
  // silently falling through an empty lookup.
  it("leaves DEXA bone density (g/cm²) unconverted under US", () => {
    expect(displayScaleFor("Total BMD", "g/cm²", 1.1, "imperial")).toEqual({ scale: 1, unit: "g/cm²" });
  });
});

describe("displayScaleFor — analyte molar (per system, either stored side)", () => {
  it("glucose stored mg/dL: US keeps mg/dL, SI converts to mmol/L (÷18.02)", () => {
    expect(displayScaleFor("Glucose", "mg/dL", 95, "imperial")).toEqual({ scale: 1, unit: "mg/dL" });
    const si = displayScaleFor("Glucose", "mg/dL", 95, "metric");
    expect(si.unit).toBe("mmol/L");
    expect(si.scale).toBeCloseTo(1 / 18.02, 10);
  });
  it("glucose stored mmol/L: SI keeps mmol/L, US converts to mg/dL (×18.02)", () => {
    expect(displayScaleFor("Glucose", "mmol/L", 5, "metric")).toEqual({ scale: 1, unit: "mmol/L" });
    const us = displayScaleFor("Glucose", "mmol/L", 5, "imperial");
    expect(us.unit).toBe("mg/dL");
    expect(us.scale).toBeCloseTo(18.02, 8);
  });
  it("creatinine mg/dL → µmol/L under SI (×88.4)", () => {
    const si = displayScaleFor("Creatinine, Serum", "mg/dL", 1, "metric");
    expect(si.unit).toBe("µmol/L");
    expect(si.scale).toBeCloseTo(88.4, 8);
  });
  it("an unmapped analyte unit is left unscaled (safe pass-through)", () => {
    // Pregnenolone is deliberately deferred (no verified factor) — must not be converted.
    expect(displayScaleFor("Pregnenolone", "ng/dL", 600, "metric")).toEqual({ scale: 1, unit: "ng/dL" });
    expect(displayScaleFor("Pregnenolone", "ng/dL", 600, "imperial")).toEqual({ scale: 1, unit: "ng/dL" });
  });
});

describe("convertForDisplay", () => {
  it("converts one reading to the chosen system", () => {
    expect(convertForDisplay("Glucose", "mg/dL", 95, "metric").unit).toBe("mmol/L");
    expect(convertForDisplay("Glucose", "mg/dL", 95, "metric").value).toBeCloseTo(95 / 18.02, 6);
    expect(convertForDisplay("Glucose", "mg/dL", 95, "imperial")).toEqual({ value: 95, unit: "mg/dL" });
  });
});
