import { describe, it, expect } from "vitest";
import { assessmentFor, matchOngoingAssessment } from "@pablotech/akesi/treatment-bucket";
import { partitionByBucket } from "../../src/lib/treatment-sidebar";
import type { Client, TreatmentItem } from "../../src/lib/types";

const TODAY = "2026-08-19";
const t = (over: Partial<TreatmentItem>): TreatmentItem =>
  ({ id: "x", name: "Tirzepatide", kind: "drug", start: "2020-01-01", ...over } as TreatmentItem);
const finding = (over: Record<string, unknown>) => ({ disease: [], ...over }) as unknown as Client["finding"];

describe("partitionByBucket", () => {
  it("splits by window, the same way bucketOf does", () => {
    const rows = [
      t({ id: "past", start: "2025-01-01", end: "2025-06-01" }),
      t({ id: "now", start: "2026-08-01", end: "2026-08-31" }),
      t({ id: "soon", start: "2026-09-01" }),
    ];
    const p = partitionByBucket(rows, TODAY);
    expect(p.past.map((r) => r.id)).toEqual(["past"]);
    expect(p.ongoing.map((r) => r.id)).toEqual(["now"]);
    expect(p.planned.map((r) => r.id)).toEqual(["soon"]);
  });

  it("always returns all three keys, so a caller need not guard", () => {
    expect(Object.keys(partitionByBucket([], TODAY)).sort()).toEqual(["ongoing", "past", "planned"]);
  });
});

describe("assessmentFor", () => {
  // The point of the milestone: one drug, three phases, three different answers.
  it("prefers the entry for the phase being rendered", () => {
    const f = finding({
      treatment: [
        { item: "Tirzepatide 9mg/week", assessment: "NOW", phase: "ongoing" },
        { item: "Tirzepatide", assessment: "THEN", phase: "past" },
        { item: "Tirzepatide 10.5mg/week", assessment: "NEXT", phase: "planned" },
      ],
    });
    expect(assessmentFor(f, "Tirzepatide", "ongoing")?.assessment).toBe("NOW");
    expect(assessmentFor(f, "Tirzepatide", "past")?.assessment).toBe("THEN");
    expect(assessmentFor(f, "Tirzepatide", "planned")?.assessment).toBe("NEXT");
  });

  // Migration: nothing goes blank and nothing regenerates until the drug is next translated.
  it("falls back to a phase-less entry under every bucket", () => {
    const f = finding({ treatment: [{ item: "Tirzepatide 9mg/week", assessment: "OLD" }] });
    for (const phase of ["past", "ongoing", "planned"] as const) {
      expect(assessmentFor(f, "Tirzepatide", phase)?.assessment).toBe("OLD");
    }
  });

  it("prefers a phased entry over a phase-less one for the same drug", () => {
    const f = finding({
      treatment: [
        { item: "Tirzepatide", assessment: "OLD" },
        { item: "Tirzepatide", assessment: "NEW", phase: "past" },
      ],
    });
    expect(assessmentFor(f, "Tirzepatide", "past")?.assessment).toBe("NEW");
    expect(assessmentFor(f, "Tirzepatide", "ongoing")?.assessment).toBe("OLD");
  });

  // The live bug that started this: the action is stored bare, the card looks up a dosed label.
  it("still reads the legacy planned store, by bare name against a dosed label", () => {
    const f = finding({ treatment: [], planAssessmentRows: [{ action: "Tirzepatide", assessment: "LEGACY" }] });
    expect(assessmentFor(f, "Tirzepatide 10.5mg/week", "planned")?.assessment).toBe("LEGACY");
  });

  it("does not leak the legacy planned store into past or ongoing", () => {
    const f = finding({ treatment: [], planAssessmentRows: [{ action: "Tirzepatide", assessment: "LEGACY" }] });
    expect(assessmentFor(f, "Tirzepatide", "past")).toBeUndefined();
    expect(assessmentFor(f, "Tirzepatide", "ongoing")).toBeUndefined();
  });

  it("carries the body-system group through", () => {
    const f = finding({ treatment: [{ item: "Tirzepatide", assessment: "A", group: "Metabolic Health", phase: "ongoing" }] });
    expect(assessmentFor(f, "Tirzepatide", "ongoing")?.group).toBe("Metabolic Health");
  });

  it("returns nothing for a drug with no assessment anywhere", () => {
    expect(assessmentFor(finding({ treatment: [] }), "Rosuvastatin", "ongoing")).toBeUndefined();
  });
});

describe("one assessment is not attributed to two drugs", () => {
  // TreatmentRow matches a whole list in one pass; without the exclusion set a single stored entry
  // satisfied several rows. The card path matches one name and passes no set.
  it("honours the caller's exclusion set across a list pass", () => {
    const entries = [{ item: "Magnesium", assessment: "A" }, { item: "Magnesium Glycinate", assessment: "B" }];
    const used = new Set<object>();
    const first = matchOngoingAssessment(entries, "Magnesium", used);
    const second = matchOngoingAssessment(entries, "Magnesium Glycinate", used);
    expect(first?.assessment).toBe("A");
    expect(second?.assessment).toBe("B");
  });

  it("keeps reverse containment — a bare stored label found from a dosed name", () => {
    expect(matchOngoingAssessment([{ item: "Tirzepatide", assessment: "A" }], "Tirzepatide 9mg/week")?.assessment).toBe("A");
  });
});

import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";

describe("treatmentAssessment merge, per (drug, phase)", () => {
  const spec = LEAF_REGEN_SPECS.treatmentAssessment;
  const client = (treatment: unknown[]) =>
    ({ finding: { disease: [{ group: "Metabolic Health" }], treatment } }) as unknown as Client;
  const item = (over: Record<string, unknown>) =>
    ({ item: "Tirzepatide", assessment: "A", group: "Metabolic Health", ...over });

  it("keeps three entries for one drug instead of overwriting", () => {
    const merged = spec.mergeInto(client([]), {
      items: [item({ phase: "past", assessment: "THEN" }), item({ phase: "ongoing", assessment: "NOW" }), item({ phase: "planned", assessment: "NEXT" })],
    });
    const rows = merged.finding!.treatment;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.phase).sort()).toEqual(["ongoing", "past", "planned"]);
  });

  it("updates one phase without disturbing the others", () => {
    const start = client([
      { item: "Tirzepatide", assessment: "THEN", group: "Metabolic Health", phase: "past" },
      { item: "Tirzepatide", assessment: "NOW", group: "Metabolic Health", phase: "ongoing" },
    ]);
    const rows = spec.mergeInto(start, { items: [item({ phase: "ongoing", assessment: "UPDATED" })] }).finding!.treatment;
    expect(rows.find((r) => r.phase === "past")?.assessment).toBe("THEN");
    expect(rows.find((r) => r.phase === "ongoing")?.assessment).toBe("UPDATED");
  });

  // Migration: the pre-phase entry must not linger once phased ones exist, or it would keep
  // answering as the fallback for phases the model deliberately did not emit.
  it("retires the phase-less entry once a phased one arrives for that drug", () => {
    const start = client([{ item: "Tirzepatide 9mg/week", assessment: "OLD", group: "Metabolic Health" }]);
    const rows = spec.mergeInto(start, { items: [item({ phase: "past", assessment: "THEN" })] }).finding!.treatment;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: "past", assessment: "THEN" });
  });

  it("leaves another drug's phase-less entry alone", () => {
    const start = client([{ item: "Rosuvastatin 20 mg", assessment: "KEEP", group: "Metabolic Health" }]);
    const rows = spec.mergeInto(start, { items: [item({ phase: "past" })] }).finding!.treatment;
    expect(rows.find((r) => r.item.startsWith("Rosuvastatin"))?.assessment).toBe("KEEP");
  });

  it("a dose change within a phase supersedes rather than duplicating", () => {
    const start = client([{ item: "Tirzepatide 9mg/week", assessment: "OLD", group: "Metabolic Health", phase: "ongoing" }]);
    const rows = spec.mergeInto(start, {
      items: [item({ item: "Tirzepatide 10.5mg/week", phase: "ongoing", assessment: "NEW" })],
    }).finding!.treatment;
    expect(rows).toHaveLength(1);
    expect(rows[0].assessment).toBe("NEW");
  });
});

import { leafContextFor } from "../../src/lib/leaf-regen-registry";
import { todayISODate } from "@pablotech/akesi/treatment-bucket";

describe("the leaf context carries Today", () => {
  // The rules were unanswerable without it. CURRENT_DOSE_RULE defines the current dose as "the row
  // whose window CONTAINS Today" and the date checklist keys off "the Today: line" — neither was in
  // the payload, so the model guessed which titration row was current, and reliably guessed wrong.
  // Live probe before this: "the current dose is 6 mg/week (May 16 – June 30)". After: 9 mg/week,
  // the row that actually contains today.
  it("includes today for the nodes whose prompts depend on it", () => {
    const c = { factors: { treatments: [] }, results: [], watchlist: [] } as unknown as Client;
    for (const node of ["treatmentAssessment", "aiOnPlan"]) {
      expect(leafContextFor(node, c).today).toBe(todayISODate());
    }
  });
});

// W71 — the id-keyed path. This section was the last one still paired by a NAME the model writes
// itself with the dose appended, which is why matchByTreatmentName has three ordered substring rules
// and a `used` set: treatment-bucket.ts took 25 changes in 403 lines building and repairing that
// guessing. An id ends it, and the old rules stay only for rows written before W71.
describe("an assessment that says which treatment it is about", () => {
  const finding = (rows: { item: string; treatmentId?: string; assessment: string; phase?: "past" | "ongoing" | "planned" }[]) =>
    ({ treatment: rows }) as unknown as NonNullable<import("../../src/lib/types").Client["finding"]>;

  it("prefers the id over any name rule", () => {
    // The name would match the WRONG row under every substring rule; the id must win.
    const f = finding([
      { treatmentId: "a", item: "Rosuvastatin 20 mg", assessment: "about A", phase: "ongoing" },
      { treatmentId: "b", item: "Rosuvastatin 10 mg", assessment: "about B", phase: "ongoing" },
    ]);
    expect(assessmentFor(f, "Rosuvastatin", "ongoing", undefined, "b")?.assessment).toBe("about B");
  });

  it("survives a rename that the name rules could not follow", () => {
    // renameAssessmentItems exists only because a rename orphaned a stored row. An id-keyed row does
    // not care what the drug is called now.
    const f = finding([{ treatmentId: "a", item: "Crestor 20 mg", assessment: "kept", phase: "ongoing" }]);
    expect(assessmentFor(f, "Rosuvastatin", "ongoing", undefined, "a")?.assessment).toBe("kept");
  });

  it("still resolves a row written before ids existed", () => {
    const f = finding([{ item: "Ezetimibe 10 mg", assessment: "legacy", phase: "ongoing" }]);
    expect(assessmentFor(f, "Ezetimibe", "ongoing", undefined, "ez-1")?.assessment).toBe("legacy");
  });

  // The failure the id is there to prevent: a row that already says which drug it belongs to must
  // never be handed to a different drug because their names happen to overlap.
  it("refuses to give one drug's id-keyed row to another drug by name", () => {
    const f = finding([{ treatmentId: "a", item: "Rosuvastatin 20 mg", assessment: "about A", phase: "ongoing" }]);
    expect(assessmentFor(f, "Rosuvastatin", "ongoing", undefined, "different-drug")).toBeUndefined();
  });

  it("and the same protection applies to un-phased legacy rows", () => {
    const f = finding([{ treatmentId: "a", item: "Rosuvastatin 20 mg", assessment: "about A" }]);
    expect(assessmentFor(f, "Rosuvastatin", "ongoing", undefined, "different-drug")).toBeUndefined();
  });

  it("marks an id-matched row used, so a second drug cannot claim it", () => {
    const f = finding([{ treatmentId: "a", item: "Rosuvastatin 20 mg", assessment: "about A", phase: "ongoing" }]);
    const used = new Set<object>();
    expect(assessmentFor(f, "Rosuvastatin", "ongoing", used, "a")?.assessment).toBe("about A");
    expect(assessmentFor(f, "Rosuvastatin", "ongoing", used, "a")).toBeUndefined();
  });
});
