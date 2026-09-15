import { describe, it, expect } from "vitest";
import {
  safeProductUrl, cleanIngredients, cleanLinks, formatIngredient, hasProductData, productCanonical,
  administrationUnitChanged,
} from "@pablotech/akesi/treatment-product";
import { treatmentCanonical } from "../../src/lib/factors-hash";
import { collapseByName, formatDose, treatmentLabel, matchPlanAssessment, matchOngoingAssessment, renameAssessmentItems } from "@pablotech/akesi/treatment-bucket";
import type { Administration, Client, TreatmentItem } from "../../src/lib/types";

const t = (over: Partial<TreatmentItem> = {}): TreatmentItem =>
  ({ id: "t1", name: "Thyroid Support", kind: "supplement", start: "2026-01-01", ...over } as TreatmentItem);
const clientWith = (...rows: TreatmentItem[]) => ({ factors: { treatments: rows } } as unknown as Client);

describe("safeProductUrl", () => {
  it("accepts http and https", () => {
    expect(safeProductUrl("https://www.marekhealth.com/coa/thyroid-support_26021005.html"))
      .toBe("https://www.marekhealth.com/coa/thyroid-support_26021005.html");
    expect(safeProductUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  // These arrive from model output over pasted text — an untrusted boundary that ends at an <a href>.
  it.each(["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "not a url", "", "  "])(
    "rejects %s", (bad) => expect(safeProductUrl(bad)).toBeNull(),
  );

  it("rejects a non-string", () => {
    expect(safeProductUrl(null)).toBeNull();
    expect(safeProductUrl({ url: "https://x.com" })).toBeNull();
  });
});

describe("cleanIngredients", () => {
  it("keeps a well-formed ingredient whole", () => {
    expect(cleanIngredients([{ name: "Selenium", amount: 100, unit: "mcg", form: "L-Selenomethionine" }]))
      .toEqual([{ name: "Selenium", amount: 100, unit: "mcg", form: "L-Selenomethionine" }]);
  });

  it("drops unnamed entries rather than storing a half-record", () => {
    expect(cleanIngredients([{ amount: 100, unit: "mcg" }, { name: "  " }, { name: "Zinc" }]))
      .toEqual([{ name: "Zinc" }]);
  });

  it("drops a non-numeric amount instead of coercing it", () => {
    expect(cleanIngredients([{ name: "Zinc", amount: "15" }])).toEqual([{ name: "Zinc" }]);
    expect(cleanIngredients([{ name: "Zinc", amount: NaN }])).toEqual([{ name: "Zinc" }]);
  });

  it("tolerates a non-array", () => expect(cleanIngredients("Selenium 100mcg")).toEqual([]));
});

describe("cleanLinks", () => {
  it("drops a link whose URL is unsafe, keeping the safe ones", () => {
    expect(cleanLinks([{ label: "COA", url: "https://a.com/c" }, { label: "x", url: "javascript:alert(1)" }]))
      .toEqual([{ label: "COA", url: "https://a.com/c" }]);
  });

  it("falls back to the host when a link has no label", () => {
    expect(cleanLinks([{ url: "https://www.marekhealth.com/coa/x.html" }]))
      .toEqual([{ label: "www.marekhealth.com", url: "https://www.marekhealth.com/coa/x.html" }]);
  });
});

describe("formatIngredient", () => {
  it("renders amount, unit, name and form", () => {
    expect(formatIngredient({ name: "Selenium", amount: 100, unit: "mcg", form: "L-Selenomethionine" }))
      .toBe("100mcg Selenium (L-Selenomethionine)");
  });
  it("renders a bare name", () => expect(formatIngredient({ name: "Taurine" })).toBe("Taurine"));
});

describe("product data never reaches the dose label", () => {
  // treatmentLabel is the cross-system matching key for stored Findings, treatmentGroups.patient and
  // Patient Plan actions. A label amount leaking into it would silently unmatch every reference.
  it("leaves formatDose and treatmentLabel untouched", () => {
    const withProduct = t({
      ingredients: [{ name: "Selenium", amount: 100, unit: "mcg" }],
      description: "MD-formulated thyroid support",
      doseAmount: 1, doseUnit: "capsule", doseFrequency: "day",
    });
    expect(formatDose(withProduct)).toBe("1capsule/day");
    expect(treatmentLabel(withProduct)).toBe("Thyroid Support 1capsule/day");
  });
});

describe("treatmentCanonical staleness", () => {
  // The rollout guard. Appending unconditionally would change every existing treatment's signature,
  // mark all of them stale, and fire a full regeneration for every user on next load.
  it("is byte-identical for a treatment with no product data", () => {
    const before = "Thyroid Support|||||supplement|2026-01-01|||";
    expect(treatmentCanonical(clientWith(t()))).toEqual([before]);
    expect(productCanonical(t())).toBe("");
  });

  it("changes once product data is added", () => {
    const plain = treatmentCanonical(clientWith(t()))[0];
    const enriched = treatmentCanonical(clientWith(t({ description: "MD-formulated" })))[0];
    expect(enriched).not.toBe(plain);
    expect(enriched.startsWith(plain)).toBe(true);
  });

  it.each([
    ["description", { description: "x" }],
    ["maker", { maker: "Thorne" }],
    ["ingredients", { ingredients: [{ name: "Selenium" }] }],
    ["links", { links: [{ label: "COA", url: "https://a.com" }] }],
    ["administration", { administration: { unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" } }],
  ])("re-triggers on a %s edit", (_label, over) => {
    expect(hasProductData(over as TreatmentItem)).toBe(true);
    expect(treatmentCanonical(clientWith(t(over as Partial<TreatmentItem>)))[0])
      .not.toBe(treatmentCanonical(clientWith(t()))[0]);
  });

  // The precise regression this file's rollout-guard comment exists to prevent: `maker` was added
  // to the schema AFTER description/ingredients/links already shipped, so a real record that
  // already has product data (but, being pre-existing, never has `maker`) must produce the exact
  // same canonical string as it did before `maker` existed — inserting a new fixed slot, even an
  // empty one, into the middle of the string would reshape it and fire an unwanted mass regen.
  it("adding the maker field does not reshape the canonical string for a record that predates it", () => {
    expect(productCanonical(t({ description: "MD-formulated" }))).toBe("|MD-formulated||");
    expect(productCanonical(t({ description: "MD-formulated", ingredients: [{ name: "Selenium" }] })))
      .toBe("|MD-formulated|Selenium|");
  });

  // administration-only (no description/ingredients/links) must still count as product data —
  // otherwise a treatment extracted with ONLY a label's serving instruction would never regen.
  it("counts administration alone as product data", () => {
    const admin = { unit: "softgel", unitsPerServing: 2, suggestedUnits: 2, suggestedFrequency: "day" } as const;
    expect(hasProductData(t({ administration: admin }))).toBe(true);
    expect(productCanonical(t({ administration: admin }))).toBe("||||softgel|2|2|day|");
  });

  it("includes containerQuantity in the canonical string when the label states a total", () => {
    const admin = { unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day", containerQuantity: 60 } as const;
    const withTotal = treatmentCanonical(clientWith(t({ administration: admin })))[0];
    const withoutTotal = treatmentCanonical(clientWith(t({ administration: { ...admin, containerQuantity: undefined } })))[0];
    expect(withTotal).not.toBe(withoutTotal);
    expect(productCanonical(t({ administration: admin }))).toBe("||||capsule|1|1|day|60");
  });
});

describe("administrationUnitChanged", () => {
  const admin = (over: Partial<Administration> = {}): Administration =>
    ({ unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day", ...over });

  it("is false when nothing new is being attached", () => {
    expect(administrationUnitChanged(admin(), undefined)).toBe(false);
  });

  it("is true on first attach, when the medicine never had administration before", () => {
    expect(administrationUnitChanged(undefined, admin())).toBe(true);
  });

  it("is true when the unit word itself differs", () => {
    expect(administrationUnitChanged(admin({ unit: "capsule" }), admin({ unit: "tablet" }))).toBe(true);
  });

  it("is false when only unitsPerServing/suggestedUnits differ, unit unchanged", () => {
    expect(administrationUnitChanged(admin({ unitsPerServing: 1, suggestedUnits: 1 }), admin({ unitsPerServing: 2, suggestedUnits: 3 })))
      .toBe(false);
  });

  it("is false when the unit differs only in case or whitespace", () => {
    expect(administrationUnitChanged(admin({ unit: " Capsule " }), admin({ unit: "capsule" }))).toBe(false);
  });
});

describe("collapseByName", () => {
  // Third time this whitelist has needed extending; anything omitted works in the editor and is
  // invisible in every read-only view.
  it("carries the product fields through a collapse", () => {
    const admin = { unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" } as const;
    const rows = [
      t({ id: "a", start: "2026-01-01", end: "2026-03-01", description: "d", maker: "Thorne", ingredients: [{ name: "Selenium" }], links: [{ label: "COA", url: "https://a.com" }], administration: admin }),
      t({ id: "b", start: "2026-03-01", description: "d", maker: "Thorne", ingredients: [{ name: "Selenium" }], links: [{ label: "COA", url: "https://a.com" }], administration: admin }),
    ];
    const [collapsed] = collapseByName(rows);
    expect(collapsed.description).toBe("d");
    expect(collapsed.maker).toBe("Thorne");
    expect(collapsed.ingredients).toEqual([{ name: "Selenium" }]);
    expect(collapsed.links).toEqual([{ label: "COA", url: "https://a.com" }]);
    expect(collapsed.administration).toEqual(admin);
  });
});

describe("assessment lookup survives real labels", () => {
  const plan = [
    { action: "Start Methylation stack (TBD)", assessment: "A" },
    { action: "Tirzepatide", assessment: "TIRZ" },
    { action: "NAC", assessment: "N" },
  ];

  // The live failure: the vault records the action as the bare drug name, while the card looked it
  // up by the dose-annotated label. An exact Map.get missed and the card read "No LexiTar
  // assessment" over a perfectly good stored one — a Translate that "failed silently".
  it("finds a bare-name action from a dose-annotated label", () => {
    expect(matchPlanAssessment(plan, "Tirzepatide 10.5mg/week")?.assessment).toBe("TIRZ");
  });

  it("finds a dose-annotated action from a bare name", () => {
    expect(matchPlanAssessment([{ action: "Tirzepatide 10.5mg/week", assessment: "TIRZ" }], "Tirzepatide")?.assessment).toBe("TIRZ");
  });

  it("still matches on the first word when the rest drifted", () => {
    expect(matchPlanAssessment([{ action: "Magnesium glycinate 1.5g/day elemental", assessment: "M" }], "Magnesium Glycinate")?.assessment).toBe("M");
  });

  it("does not match an unrelated action", () => {
    expect(matchPlanAssessment(plan, "Rosuvastatin 20mg")).toBeUndefined();
  });

  it("planned and ongoing lookups agree on the same drug", () => {
    expect(matchPlanAssessment([{ action: "Tirzepatide", assessment: "P" }], "Tirzepatide 9mg/week")?.assessment).toBe("P");
    expect(matchOngoingAssessment([{ item: "Tirzepatide", assessment: "O" }], "Tirzepatide 9mg/week")?.assessment).toBe("O");
  });
});

describe("renameAssessmentItems", () => {
  // A rename used to orphan the stored turn: still there, under a name nothing looks up, so the card
  // went blank the instant Save was pressed — and stayed blank if the regen then failed.
  it("carries the assessment onto the new name, keeping the model's dose annotation", () => {
    const entries = [{ item: "Thyroid Support 1 capsule", assessment: "A" }, { item: "NAC", assessment: "B" }];
    renameAssessmentItems(entries, "Thyroid Support", "Marek Thyroid Support");
    expect(entries[0].item).toBe("Marek Thyroid Support 1 capsule");
    expect(entries[1].item).toBe("NAC");
  });

  it("is a no-op when the name did not really change", () => {
    const entries = [{ item: "NAC", assessment: "B" }];
    renameAssessmentItems(entries, "NAC", "  nac  ");
    expect(entries[0].item).toBe("NAC");
  });

  it("leaves the stored turn findable afterwards", () => {
    const entries = [{ item: "Thyroid Support", assessment: "A" }];
    renameAssessmentItems(entries, "Thyroid Support", "Marek Thyroid Support");
    expect(matchOngoingAssessment(entries, "Marek Thyroid Support")?.assessment).toBe("A");
  });
});
