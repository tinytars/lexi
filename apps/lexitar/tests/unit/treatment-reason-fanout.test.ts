import { describe, it, expect } from "vitest";
import { fanoutReason } from "../../src/lib/treatment-reason-fanout";
import type { TreatmentItem } from "../../src/lib/types";

function row(overrides: Partial<TreatmentItem> = {}): TreatmentItem {
  return { id: "id-1", name: "Metformin", start: "2026-01-01", ...overrides };
}

describe("fanoutReason", () => {
  it("sets reason on sibling rows matching the name, case/whitespace-insensitively", () => {
    const rows = [row({ id: "a", name: "  Metformin  " }), row({ id: "b", name: "metformin" })];
    fanoutReason(rows, "b", "metformin", "diabetes");
    expect(rows[0].reason).toBe("diabetes");
  });

  it("skips the row with the just-saved id, even though its name matches", () => {
    const rows = [row({ id: "saved", name: "Metformin", reason: "already set" })];
    fanoutReason(rows, "saved", "metformin", "diabetes");
    expect(rows[0].reason).toBe("already set");
  });

  it("leaves non-matching names untouched", () => {
    const rows = [row({ id: "x", name: "Aspirin" })];
    fanoutReason(rows, "saved", "metformin", "diabetes");
    expect(rows[0].reason).toBeUndefined();
  });

  it("can clear reason by passing undefined", () => {
    const rows = [row({ id: "a", name: "Metformin", reason: "old" })];
    fanoutReason(rows, "saved", "metformin", undefined);
    expect(rows[0].reason).toBeUndefined();
  });

  it("does nothing for undefined rows", () => {
    expect(() => fanoutReason(undefined, "saved", "metformin", "x")).not.toThrow();
  });
});
