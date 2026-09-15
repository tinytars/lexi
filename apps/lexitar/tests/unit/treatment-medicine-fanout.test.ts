import { describe, it, expect } from "vitest";
import { planMedicineFanout, applyMedicineFanoutPatch, type MedicineFanoutFields } from "../../src/lib/treatment-medicine-fanout";
import type { Administration, TreatmentItem } from "../../src/lib/types";

function fields(overrides: Partial<MedicineFanoutFields> = {}): MedicineFanoutFields {
  return { name: "Metformin", kind: "drug", attachments: [], ...overrides };
}

function administration(overrides: Partial<Administration> = {}): Administration {
  return { unit: "mg", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day", ...overrides };
}

function row(overrides: Partial<TreatmentItem> = {}): TreatmentItem {
  return { id: "id-1", name: "Metformin", start: "2026-01-01", ...overrides };
}

describe("planMedicineFanout", () => {
  it("relabels when there was no prior administration and one is now set", () => {
    const { relabelUnit } = planMedicineFanout(fields({ administration: administration({ unit: "mg" }) }), undefined);
    expect(relabelUnit).toBe("mg");
  });

  it("does not relabel when the unit is unchanged (case/whitespace-insensitive)", () => {
    const prev = administration({ unit: " MG " });
    const { relabelUnit } = planMedicineFanout(fields({ administration: administration({ unit: "mg" }) }), prev);
    expect(relabelUnit).toBeNull();
  });

  it("relabels when the unit actually changed", () => {
    const prev = administration({ unit: "mg" });
    const { relabelUnit, patch } = planMedicineFanout(fields({ administration: administration({ unit: "mcg" }) }), prev);
    expect(relabelUnit).toBe("mcg");
    expect(patch.doseUnit).toBe("mcg");
  });

  it("does not set patch.doseUnit when there is no relabel", () => {
    const { patch } = planMedicineFanout(fields(), undefined);
    expect(patch).not.toHaveProperty("doseUnit");
  });

  it("always sets name, kind, attachments, and clears the legacy images field", () => {
    const { patch } = planMedicineFanout(fields({ name: "Vitamin D", kind: "supplement", attachments: [] }), undefined);
    expect(patch.name).toBe("Vitamin D");
    expect(patch.kind).toBe("supplement");
    expect(patch.attachments).toEqual([]);
    expect(patch.images).toBeUndefined();
    expect(patch).toHaveProperty("images");
  });

  it("clears optional product fields on the patch when absent — a medicine-scope save replaces the whole product, it doesn't merge", () => {
    const { patch } = planMedicineFanout(fields(), undefined);
    expect(patch.description).toBeUndefined();
    expect(patch.maker).toBeUndefined();
    expect(patch.ingredients).toBeUndefined();
    expect(patch.links).toBeUndefined();
    expect(patch.administration).toBeUndefined();
    expect(patch.extracted).toBeUndefined();
    expect(patch.rawCaptureAttachmentKeys).toBeUndefined();
    // Explicitly present (not omitted), so Object.assign actually clears a sibling row's stale value
    // instead of leaving it untouched.
    expect(patch).toHaveProperty("description");
    expect(patch).toHaveProperty("maker");
  });

  it("copies optional product fields (not the same reference) when present", () => {
    const ingredients = [{ name: "metformin HCl" }];
    const { patch } = planMedicineFanout(fields({ ingredients, maker: "Acme" }), undefined);
    expect(patch.ingredients).toEqual(ingredients);
    expect(patch.ingredients).not.toBe(ingredients);
    expect(patch.maker).toBe("Acme");
  });
});

describe("applyMedicineFanoutPatch", () => {
  it("applies the patch to every row matching the name, case/whitespace-insensitively", () => {
    const rows = [row({ id: "a", name: "  Metformin  " }), row({ id: "b", name: "metformin" }), row({ id: "c", name: "Aspirin" })];
    applyMedicineFanoutPatch(rows, "metformin", { reason: "diabetes" });
    expect(rows[0].reason).toBe("diabetes");
    expect(rows[1].reason).toBe("diabetes");
    expect(rows[2].reason).toBeUndefined();
  });

  it("does nothing for undefined rows", () => {
    expect(() => applyMedicineFanoutPatch(undefined, "metformin", { reason: "x" })).not.toThrow();
  });
});
