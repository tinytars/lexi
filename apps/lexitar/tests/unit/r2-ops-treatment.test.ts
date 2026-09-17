import { describe, it, expect } from "vitest";
import { staleLeafNodes, selectTreatmentRows, applyPhotoExtractPatch } from "../../scripts/commands/r2-ops";
import type { TreatmentItem } from "../../src/lib/types";
import type { ProposedTreatment } from "@pablotech/akesi/treatment-infer";

function treatment(overrides: Partial<TreatmentItem> = {}): TreatmentItem {
  return { id: "row_1", name: "Fish Oil", start: "2026-01-01", ...overrides };
}

describe("staleLeafNodes", () => {
  it("returns only the sweepable nodes present in the stale set, in the sweep's own order", () => {
    const stale = new Set(["noteResults", "hypothesisEvaluation", "someUnrelatedNode"]);
    expect(staleLeafNodes(stale)).toEqual(["hypothesisEvaluation", "noteResults"]);
  });

  it("returns nothing when the stale set has no sweepable nodes", () => {
    expect(staleLeafNodes(new Set(["someUnrelatedNode"]))).toEqual([]);
  });

  it("returns nothing for an empty stale set", () => {
    expect(staleLeafNodes(new Set())).toEqual([]);
  });
});

describe("selectTreatmentRows", () => {
  const rows = [
    treatment({ id: "a", name: "Fish Oil" }),
    treatment({ id: "b", name: "  fish oil  " }),
    treatment({ id: "c", name: "Vitamin D" }),
  ];

  it("matches by name case-insensitively and trims whitespace on both sides", () => {
    expect(selectTreatmentRows(rows, "FISH OIL").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("narrows further by id when given", () => {
    expect(selectTreatmentRows(rows, "Fish Oil", "b").map((r) => r.id)).toEqual(["b"]);
  });

  it("returns nothing for an id that doesn't match any name-matched row", () => {
    expect(selectTreatmentRows(rows, "Fish Oil", "z")).toEqual([]);
  });

  it("returns nothing for a name with no matches", () => {
    expect(selectTreatmentRows(rows, "Aspirin")).toEqual([]);
  });
});

describe("applyPhotoExtractPatch", () => {
  const proposed: ProposedTreatment = {
    name: "Fish Oil",
    kind: "supplement",
    description: "Omega-3 supplement",
    maker: "Acme",
    ingredients: [{ name: "EPA", amount: 500, unit: "mg" }],
    links: [{ label: "Label photo", url: "https://example.com/label.jpg" }],
    administration: { unit: "capsule", unitsPerServing: 2, suggestedUnits: 2, suggestedFrequency: "day" },
  };

  it("copies the proposed label fields onto every row and stamps extracted/rawCaptureAttachmentKeys", () => {
    const rows = [
      treatment({ id: "a", attachments: [{ key: "raw/a.jpg", name: "a.jpg", mediaType: "image/jpeg", bytes: 1, addedAt: "t" }] }),
      treatment({ id: "b" }),
    ];
    applyPhotoExtractPatch(rows, proposed, () => "2026-09-16T00:00:00.000Z");

    for (const row of rows) {
      expect(row.description).toBe("Omega-3 supplement");
      expect(row.maker).toBe("Acme");
      expect(row.ingredients).toEqual(proposed.ingredients);
      expect(row.links).toEqual(proposed.links);
      expect(row.administration).toEqual(proposed.administration);
      expect(row.extracted).toEqual({ via: "photo", at: "2026-09-16T00:00:00.000Z" });
    }
    expect(rows[0].rawCaptureAttachmentKeys).toEqual(["raw/a.jpg"]);
    expect(rows[1].rawCaptureAttachmentKeys).toEqual([]);
  });

  it("relabels doseUnit only when the extraction's administration unit actually changed", () => {
    const changed = [treatment({ doseUnit: "pill", administration: { unit: "pill", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" } })];
    applyPhotoExtractPatch(changed, proposed);
    expect(changed[0].doseUnit).toBe("capsule");

    const unchanged = [treatment({ doseUnit: "capsule", administration: { unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" } })];
    applyPhotoExtractPatch(unchanged, proposed);
    expect(unchanged[0].doseUnit).toBe("capsule");
  });

  it("leaves doseUnit untouched when the row had no prior administration (treated as changed by administrationUnitChanged, but there is nothing to compare a relabel against beyond adopting the new unit)", () => {
    const rows = [treatment({ doseUnit: undefined, administration: undefined })];
    applyPhotoExtractPatch(rows, proposed);
    expect(rows[0].doseUnit).toBe("capsule");
  });
});
