import { describe, it, expect } from "vitest";
import {
  ANALYTE,
  toCanonical,
  normalizeSeries,
  recognizes,
  canonicalUnit,
  VERIFIED_NO_CONVERT_UNITS,
} from "@pablotech/akesi/unit-systems";
import { displayScaleFor } from "../../src/lib/units";

describe("toCanonical / normalizeSeries", () => {
  it("folds a US analyte unit to its SI canonical (glucose mg/dL → mmol/L)", () => {
    const c = toCanonical("Glucose", "mg/dL", 95);
    expect(c.unit).toBe("mmol/L");
    expect(c.value).toBeCloseTo(95 / 18.02, 6);
  });
  it("leaves an already-canonical or unrecognized unit unchanged", () => {
    expect(toCanonical("Glucose", "mmol/L", 5)).toEqual({ value: 5, unit: "mmol/L" });
    expect(toCanonical("Pregnenolone", "ng/dL", 600)).toEqual({ value: 600, unit: "ng/dL" }); // deferred → unchanged
  });
  it("leaves a single-unit series untouched (no Finding/CLI churn)", () => {
    const rows = [
      { marker: "Glucose", unit: "mg/dL", value: 90 },
      { marker: "Glucose", unit: "mg/dL", value: 100 },
    ];
    expect(normalizeSeries(rows)).toBe(rows);
  });
  it("reconciles a MIXED-unit series to one canonical unit", () => {
    const rows = [
      { marker: "Glucose", unit: "mg/dL", value: 90 },
      { marker: "Glucose", unit: "mmol/L", value: 6 },
    ];
    const out = normalizeSeries(rows);
    expect(out.every((r) => r.unit === "mmol/L")).toBe(true);
    expect(out[0].value).toBeCloseTo(90 / 18.02, 6);
    expect(out[1].value).toBe(6);
  });
});

describe("per-analyte round-trip (US → SI → US within tolerance)", () => {
  for (const [marker, rule] of Object.entries(ANALYTE)) {
    it(`${marker} (${rule.us} ↔ ${rule.si})`, () => {
      const usValue = 100;
      const toSi = displayScaleFor(marker, rule.us, usValue, "metric");
      expect(toSi.unit).toBe(rule.si);
      const siValue = usValue * toSi.scale;
      const backToUs = displayScaleFor(marker, rule.si, siValue, "imperial");
      expect(backToUs.unit).toBe(rule.us);
      expect(siValue * backToUs.scale).toBeCloseTo(usValue, 6);
    });
  }
});

// Cross-check: the lipid/glucose factors mirror the in-repo ingest table (1/k == NORMALIZE
// factor) so display conversion and parse-time normalization can never silently diverge.
describe("ingest NORMALIZE ↔ ANALYTE factor parity", () => {
  const NORMALIZE_FACTORS: Record<string, number> = {
    Triglycerides: 88.57, "HDL-C": 38.67, "LDL-C": 38.67, "Non-HDL Cholesterol": 38.67,
    "Total Cholesterol": 38.67, "VLDL Cholesterol Cal": 38.67, Glucose: 18.02,
    "Estimated Average Glucose (eAG)": 18.02, "Apolipoprotein B": 100, "Apolipoprotein A-1": 100,
  };
  for (const [marker, factor] of Object.entries(NORMALIZE_FACTORS)) {
    it(`${marker}: 1/k == ${factor}`, () => {
      expect(1 / ANALYTE[marker].k).toBeCloseTo(factor, 6);
    });
  }
});

describe("recognizes", () => {
  it("g/L serum proteins are recognized (dimensional mg/dL conversion), not flagged unmapped", () => {
    expect(recognizes("Gamma Globulin, Serum", "g/L")).toBe(true);
  });
});

// M93 — compound clinical units researched as universal (no US-customary form in routine use)
// are explicitly classified as recognized, not silently unclassified.
describe("VERIFIED_NO_CONVERT_UNITS — compound units with no real US-customary form", () => {
  for (const unit of VERIFIED_NO_CONVERT_UNITS) {
    it(`${unit} is recognized regardless of marker`, () => {
      expect(recognizes("Any Marker Name", unit)).toBe(true);
    });
  }
  it("passes through unchanged via toCanonical", () => {
    expect(toCanonical("Total BMD", "g/cm²", 1.1)).toEqual({ value: 1.1, unit: "g/cm²" });
  });
});

// M93 — eGFR's two source-format unit-string variants are cosmetic aliases of the same unit.
describe("canonicalUnit — eGFR source-format aliases", () => {
  it("collapses both raw variants to one canonical label", () => {
    expect(canonicalUnit("mL/min /1.73m2")).toBe("mL/min/1.73m²");
    expect(canonicalUnit("mL/min per 1.73 m2")).toBe("mL/min/1.73m²");
  });
  it("toCanonical folds either variant to the same canonical unit", () => {
    expect(toCanonical("eGFR / Cystatin C", "mL/min /1.73m2", 90).unit).toBe("mL/min/1.73m²");
    expect(toCanonical("eGFR - Estimated Glomerular Filtration Rate (Non-African Am)", "mL/min per 1.73 m2", 90).unit).toBe("mL/min/1.73m²");
  });
});

// M93 — urine albumin/creatinine ratio: a real US (mg/g creat) vs SI/international (mg/mmol
// creat) convention difference, unlike the universal units above. NEEDS VERIFICATION against a
// clinical reference before relying on this beyond this test's round-trip check.
describe("Albumin/Creatinine Ratio — US mg/g creat ↔ SI mg/mmol creat", () => {
  it("converts mg/g creat to mg/mmol creat (×0.1131)", () => {
    const marker = "Albumin/Creatinine Ratio, Random Urine";
    const c = toCanonical(marker, "mg/g creat", 30);
    expect(c.unit).toBe("mg/mmol creat");
    expect(c.value).toBeCloseTo(30 * 0.1131, 6);
  });
});
