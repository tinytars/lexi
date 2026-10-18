import { describe, it, expect } from "vitest";
import { normalizeTreatmentName, matchesTreatmentName } from "../../src/lib/treatment-name-match";

describe("normalizeTreatmentName", () => {
  it("trims and lowercases", () => {
    expect(normalizeTreatmentName("  Metformin  ")).toBe("metformin");
  });
});

describe("matchesTreatmentName", () => {
  it("matches names differing only by case and surrounding whitespace", () => {
    expect(matchesTreatmentName("Metformin", "  metformin  ")).toBe(true);
  });
  it("does not match different names", () => {
    expect(matchesTreatmentName("Metformin", "Metoprolol")).toBe(false);
  });
});
