import { describe, it, expect } from "vitest";
import { hasAnyDose, editIndexOf } from "../../src/lib/treatment-row-lookup";
import type { TreatmentItem } from "../../src/lib/types";

function row(overrides: Partial<TreatmentItem> = {}): TreatmentItem {
  return { id: "id-1", name: "Metformin", start: "2026-01-01", ...overrides };
}

describe("hasAnyDose", () => {
  it("is true when a row with that name (case/whitespace-insensitive) has a doseAmount", () => {
    const rows = [row({ name: "  Metformin  ", doseAmount: 500 })];
    expect(hasAnyDose("metformin", rows)).toBe(true);
  });
  it("is false when the matching row has no doseAmount", () => {
    const rows = [row({ doseAmount: undefined })];
    expect(hasAnyDose("Metformin", rows)).toBe(false);
  });
  it("is true for a dose of 0 — null-check, not truthy-check", () => {
    const rows = [row({ doseAmount: 0 })];
    expect(hasAnyDose("Metformin", rows)).toBe(true);
  });
  it("is false when no row matches the name", () => {
    const rows = [row({ name: "Metoprolol", doseAmount: 25 })];
    expect(hasAnyDose("Metformin", rows)).toBe(false);
  });
  it("is false for undefined treatments", () => {
    expect(hasAnyDose("Metformin", undefined)).toBe(false);
  });
});

describe("editIndexOf", () => {
  it("returns the index of the row with the matching id", () => {
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
    expect(editIndexOf("b", rows)).toBe(1);
  });
  it("returns -1 when no row matches", () => {
    const rows = [row({ id: "a" })];
    expect(editIndexOf("z", rows)).toBe(-1);
  });
  it("returns -1 for undefined treatments", () => {
    expect(editIndexOf("a", undefined)).toBe(-1);
  });
});
