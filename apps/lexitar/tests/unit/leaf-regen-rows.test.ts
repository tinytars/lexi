import { describe, it, expect } from "vitest";
import { mergeLabeledItems, labelSubject } from "../../src/lib/leaf-regen-rows";

// The bug that made re-translating look like a dead button: these labels carry the dose, so a regen
// that re-reads the dose answers under a drifted label, which used to append beside the stale entry
// while every reader kept finding the stale one first.
describe("leaf-regen-rows: superseding a drifted label", () => {
  it("labelSubject strips a dose suffix but keeps the rest of the name", () => {
    expect(labelSubject("Rosuvastatin 20 mg")).toBe("rosuvastatin");
    expect(labelSubject("Rosuvastatin 20mg/day")).toBe("rosuvastatin");
    // A shared first word must NOT collapse two different agents.
    expect(labelSubject("Magnesium Glycinate 1.5g/day elemental")).toBe("magnesium glycinate");
    expect(labelSubject("Magnesium Citrate")).toBe("magnesium citrate");
  });

  it("a re-answer under a drifted label replaces the stale entry instead of duplicating it", () => {
    const existing = [{ item: "Rosuvastatin 20 mg", assessment: "stale — mentions a phantom NAC", group: "CV" }];
    const returned = [{ item: "Rosuvastatin 20mg/day", assessment: "fresh", group: "CV" }];
    const merged = mergeLabeledItems(
      existing, returned, (t) => t.item.toLowerCase(),
      (item, prev) => (prev ? { ...prev, item: item.item, assessment: item.assessment } : { ...item }),
      (t) => labelSubject(t.item),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].assessment).toBe("fresh");
    expect(merged[0].item).toBe("Rosuvastatin 20mg/day");
  });

  it("leaves entries about other subjects untouched", () => {
    const existing = [
      { item: "Rosuvastatin 20 mg", assessment: "old", group: "CV" },
      { item: "Ezetimibe 10mg/day", assessment: "keep me", group: "CV" },
    ];
    const merged = mergeLabeledItems(
      existing, [{ item: "Rosuvastatin 20mg/day", assessment: "fresh", group: "CV" }],
      (t) => t.item.toLowerCase(), undefined, (t) => labelSubject(t.item),
    );
    // The superseded entry vacates its slot; the fresh answer is appended.
    expect(merged.map((m) => m.item)).toEqual(["Ezetimibe 10mg/day", "Rosuvastatin 20mg/day"]);
  });

  it("without subjectOf the old append-and-keep behaviour is unchanged (id-keyed nodes)", () => {
    const merged = mergeLabeledItems(
      [{ item: "A 1 mg", assessment: "old" }], [{ item: "A 2 mg", assessment: "new" }],
      (t) => t.item.toLowerCase(),
    );
    expect(merged).toHaveLength(2);
  });
});
