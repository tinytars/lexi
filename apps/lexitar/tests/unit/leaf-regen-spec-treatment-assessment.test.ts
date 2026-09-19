import { describe, it, expect } from "vitest";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import { client } from "../fixtures/leaf-regen-client";

// mergeInto matches an exact stored label, which e2e cannot construct without the private vault fixture.
const taSpec = LEAF_REGEN_SPECS.treatmentAssessment;

describe("leaf-regen-specs: treatmentAssessment", () => {
  it("registers a spec with its own tool schema, using the default generic buildContext", () => {
    expect(taSpec).toBeDefined();
    expect((taSpec.toolSchema as { name: string }).name).toBe("emit_treatment_assessment");
    expect(taSpec.buildContext).toBeUndefined();
  });

  it("isEmpty is true only when treatmentHistory is empty", () => {
    expect(taSpec.isEmpty!({ treatmentHistory: [] })).toBe(true);
    expect(taSpec.isEmpty!({ treatmentHistory: [{ name: "Ezetimibe" }] })).toBe(false);
  });

  it("validate accepts a well-formed items array and rejects a malformed payload", () => {
    const good = { items: [{ treatmentId: "ez-1", item: "Ezetimibe 10 mg", assessment: "Holding ApoB down.", group: "Cardiovascular Risk" }] };
    expect(taSpec.validate(good)).toEqual(good);
    expect(() => taSpec.validate({})).toThrow(/items missing/);
    expect(() => taSpec.validate({ items: [{ item: "x" }] })).toThrow(/item, assessment, group/);
  });

  // Pairing by a model-written name (with the dose appended) needed guesswork; the id removes it.
  describe("the answer says which treatment it is about", () => {
    it("rejects an entry with no treatmentId", () => {
      expect(() =>
        taSpec.validate({ items: [{ item: "Ezetimibe 10 mg", assessment: "a", group: "Cardiovascular Risk" }] }),
      ).toThrow(/missing treatmentId/);
    });

    it("rejects a blank one, which is the same thing wearing a string", () => {
      expect(() =>
        taSpec.validate({ items: [{ treatmentId: "  ", item: "E", assessment: "a", group: "Cardiovascular Risk" }] }),
      ).toThrow(/missing treatmentId/);
    });

    it("names the entry in the error, so a failure says WHICH drug came back unkeyed", () => {
      expect(() =>
        taSpec.validate({ items: [{ item: "Rosuvastatin 20 mg", assessment: "a", group: "Cardiovascular Risk" }] }),
      ).toThrow(/Rosuvastatin 20 mg/);
    });

    it("refuses an id the model was never shown", () => {
      // Otherwise a hallucinated id appends a row keyed to nothing, which reads on the page as an
      // assessment of a drug the patient is not taking.
      const context = { treatmentHistory: [{ id: "ez-1", name: "Ezetimibe" }] };
      expect(() =>
        taSpec.checkAgainstInput!(context, { items: [{ treatmentId: "made-up", item: "X", assessment: "a", group: "g" }] } as never),
      ).toThrow(/unknown treatment id\(s\): made-up/);
    });

    it("accepts ids it was shown", () => {
      const context = { treatmentHistory: [{ id: "ez-1", name: "Ezetimibe" }, { id: "ro-1", name: "Rosuvastatin" }] };
      expect(() =>
        taSpec.checkAgainstInput!(context, {
          items: [
            { treatmentId: "ez-1", item: "Ezetimibe 10 mg", assessment: "a", group: "g" },
            { treatmentId: "ro-1", item: "Rosuvastatin 20 mg", assessment: "b", group: "g" },
          ],
        } as never),
      ).not.toThrow();
    });

    it("pairs by id even when the model rewrites the name entirely", () => {
      // The case name-matching cannot survive: a dose change rewrites the label, and all three
      // substring rules in matchByTreatmentName are about the label.
      const c = client();
      const stored = c.finding!.treatment[0];
      c.finding!.treatment = [{ ...stored, treatmentId: "ez-1" }];
      const updated = taSpec.mergeInto(c, {
        items: [{ treatmentId: "ez-1", item: "Ezetimibe 20 mg (dose doubled)", assessment: "Refreshed.", group: "Cardiovascular Risk" }],
      });
      // One row, updated in place — not a second row appended beside the first.
      expect(updated.finding!.treatment).toHaveLength(1);
      expect(updated.finding!.treatment[0].assessment).toBe("Refreshed.");
      expect(updated.finding!.treatment[0].treatmentId).toBe("ez-1");
    });

    it("does not let two drugs with overlapping names claim each other's assessment", () => {
      // "Rosuvastatin" and "Rosuvastatin/Ezetimibe" both contain the same first word, which is the
      // third fallback rule in matchByTreatmentName.
      const c = client();
      c.finding!.treatment = [
        { treatmentId: "a", item: "Rosuvastatin 20 mg", assessment: "about A", group: "Cardiovascular Risk" },
        { treatmentId: "b", item: "Rosuvastatin/Ezetimibe 20/10 mg", assessment: "about B", group: "Cardiovascular Risk" },
      ];
      const updated = taSpec.mergeInto(c, {
        items: [{ treatmentId: "b", item: "Rosuvastatin/Ezetimibe 20/10 mg", assessment: "ONLY B changed", group: "Cardiovascular Risk" }],
      });
      expect(updated.finding!.treatment.find((t) => t.treatmentId === "a")!.assessment).toBe("about A");
      expect(updated.finding!.treatment.find((t) => t.treatmentId === "b")!.assessment).toBe("ONLY B changed");
    });

    it("upgrades a stored row that predates ids, rather than duplicating it", () => {
      const c = client(); // its stored row has no treatmentId
      expect(c.finding!.treatment[0].treatmentId).toBeUndefined();
      const updated = taSpec.mergeInto(c, {
        items: [{ treatmentId: "ez-1", item: "Ezetimibe 10 mg", assessment: "Refreshed.", group: "Cardiovascular Risk" }],
      });
      expect(updated.finding!.treatment).toHaveLength(1);
      expect(updated.finding!.treatment[0].treatmentId).toBe("ez-1");
    });

    // Regression: a pre-phase stored row (phase undefined) never matched a real answer's phase, so every regen appended a hidden duplicate.
    it("upgrades a stored row that predates ids AND predates phase — the shape every real answer has", () => {
      const c = client();
      expect(c.finding!.treatment[0].treatmentId).toBeUndefined();
      expect(c.finding!.treatment[0].phase).toBeUndefined();
      const updated = taSpec.mergeInto(c, {
        items: [{ treatmentId: "ez-1", item: "Ezetimibe 10 mg", assessment: "Refreshed.", group: "Cardiovascular Risk", phase: "ongoing" }],
      });
      expect(updated.finding!.treatment).toHaveLength(1);
      expect(updated.finding!.treatment[0].treatmentId).toBe("ez-1");
      expect(updated.finding!.treatment[0].phase).toBe("ongoing");
      expect(updated.finding!.treatment[0].assessment).toBe("Refreshed.");
      // A second regen against the now-stamped row must patch in place, not append a second copy.
      const again = taSpec.mergeInto(updated, {
        items: [{ treatmentId: "ez-1", item: "Ezetimibe 10 mg", assessment: "Refreshed again.", group: "Cardiovascular Risk", phase: "ongoing" }],
      });
      expect(again.finding!.treatment).toHaveLength(1);
      expect(again.finding!.treatment[0].assessment).toBe("Refreshed again.");
    });
  });

  it("mergeInto updates only the matched item's assessment (case-insensitive), leaving item/group and unmatched entries untouched", () => {
    const c = client();
    const result = { items: [{ item: "EZETIMIBE 10 MG", assessment: "Refreshed read.", group: "Cardiovascular Risk" }] };
    const updated = taSpec.mergeInto(c, result);
    expect(updated.finding!.treatment).toEqual([{ item: "Ezetimibe 10 mg", assessment: "Refreshed read.", group: "Cardiovascular Risk" }]);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.treatment[0].assessment).toBe("old assessment");
  });

  it("mergeInto leaves an existing entry untouched when its item isn't among the returned items", () => {
    const c = client();
    const result = { items: [{ item: "Some Other Drug", assessment: "x", group: "Cardiovascular Risk" }] };
    const updated = taSpec.mergeInto(c, result);
    expect(updated.finding!.treatment[0]).toEqual(c.finding!.treatment[0]);
  });

  it("mergeInto collapses a stale dose-labelled duplicate rather than leaving both (the re-translate bug)", () => {
    const c = client();
    c.finding!.treatment = [
      { item: "Rosuvastatin 20 mg", assessment: "stale", group: "Cardiovascular Risk" },
      { item: "Ezetimibe 10 mg", assessment: "old assessment", group: "Cardiovascular Risk" },
    ];
    const result = { items: [{ item: "Rosuvastatin 20mg/day", assessment: "fresh", group: "Cardiovascular Risk" }] };
    const updated = taSpec.mergeInto(c, result);
    const rosu = updated.finding!.treatment.filter((t) => /rosuva/i.test(t.item));
    expect(rosu).toHaveLength(1);
    expect(rosu[0].assessment).toBe("fresh");
    expect(updated.finding!.treatment).toHaveLength(2);
  });

  it("mergeInto appends a new entry for an item name with no prior finding.treatment row (e.g. a Treatment added since the last full regen)", () => {
    const c = client();
    const result = { items: [{ item: "Some Other Drug", assessment: "Newly generated read.", group: "Cardiovascular Risk" }] };
    const updated = taSpec.mergeInto(c, result);
    expect(updated.finding!.treatment).toEqual([
      { item: "Ezetimibe 10 mg", assessment: "old assessment", group: "Cardiovascular Risk" },
      { item: "Some Other Drug", assessment: "Newly generated read.", group: "Cardiovascular Risk" },
    ]);
  });

  it("mergeInto throws when a returned group isn't one of the current disease groups", () => {
    const c = client();
    const bad = { items: [{ item: "Ezetimibe 10 mg", assessment: "x", group: "Not A Real Group" }] };
    expect(() => taSpec.mergeInto(c, bad)).toThrow(/not one of the current disease groups/);
  });
});
