import { describe, it, expect } from "vitest";
import { assembledFindingViolations } from "../../src/lib/finding-invariants";
import { mergeLeafResult } from "../../src/lib/leaf-regen-registry";
import { BASIS_KEYS } from "@pablotech/akesi-pil/finding-assemble";
import type { Client } from "../../src/lib/types";

// The load-bearing test in this file is the FIRST one: a realistic assembled Finding must produce zero
// violations. Every rule here runs on every refresh, so a single false positive would cry wolf on
// output that is actually fine, and the whole check would be ignored within a week.
//
// It is also the record of which of finding-assemble.ts's rules were deliberately NOT carried over.
// Re-add the drug-name dedupe (finding-assemble.ts:281) and this test fails, because
// treatmentAssessment legitimately emits one entry per phase for the same drug.

const decision = (intervention: string) => ({
  intervention,
  purpose: "a stated purpose",
  pros: ["p1", "p2"],
  cons: ["c1", "c2"],
  alternatives: ["a1", "a2"],
  recommendation: "Discuss with the prescribing physician.",
});

const fullBasis = () => Object.fromEntries(BASIS_KEYS.map((k) => [k, "Based on user input."]));

/** A Finding shaped like a real post-merge one: three phases of one drug, all nine leaf sections. */
function assembled(): Client {
  return {
    displayName: "Pablo",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: {
      decisions: [
        { intervention: "Pregnenolone", purpose: "sleep" },
        { intervention: "Methylation stack", purpose: "HRV" },
      ],
      treatments: [
        { id: "t1", name: "Rosuvastatin", doseAmount: 20, doseUnit: "mg", doseFrequency: "day", start: "2025-01" },
        { id: "t2", name: "Tirzepatide", doseAmount: 9, doseUnit: "mg", doseFrequency: "week", start: "2099-06" },
      ],
      noteEntries: [{ id: "n1", text: "Tingling in my left hand." }],
      allergies: [{ id: "al1", allergen: "Pollen", reaction: "" }],
      familyHistory: [{ id: "fh1", relation: "Mother", condition: "Type 2 diabetes" }],
      diseases: [{ id: "dx1", date: "2021-10", diagnostic: "Coronary artery disease" }],
    },
    finding: {
      progression: { latest: "l", recent: "r", overall: "o" },
      disease: [
        { group: "Cardiovascular Risk", finding: "x" },
        { group: "Metabolic Health", finding: "y" },
      ],
      // The phased case: three entries for ONE drug. finding-assemble.ts:281 rejects this; that rule
      // is intentionally absent here.
      treatment: [
        { item: "Rosuvastatin 10mg/day", assessment: "past arc", group: "Cardiovascular Risk", phase: "past" },
        { item: "Rosuvastatin 20mg/day", assessment: "current", group: "Cardiovascular Risk", phase: "ongoing" },
        { item: "Rosuvastatin 40mg/day", assessment: "planned", group: "Cardiovascular Risk", phase: "planned" },
      ],
      studyResults: [{ study: "S", result: "r", group: "Cardiovascular Risk" }],
      noteResults: [{ noteId: "n1", result: "r", group: "Cardiovascular Risk" }],
      allergyResults: [{ allergyId: "al1", result: "r", group: "Cardiovascular Risk" }],
      familyResults: [{ familyId: "fh1", result: "r", group: "Metabolic Health" }],
      diseaseResults: [{ diseaseId: "dx1", result: "r", group: "Cardiovascular Risk" }],
      decisions: {
        patient: [decision("Pregnenolone"), decision("Methylation stack")],
        ai: [decision("Ezetimibe"), decision("Bempedoic acid")],
      },
      doctorConversation: [
        { group: "Cardiovascular Risk", questions: ["q"] },
        { group: "Metabolic Health", questions: ["q"] },
        { group: "Pregnenolone", questions: ["q"] },
        { group: "Methylation stack", questions: ["q"] },
        { group: "Ezetimibe", questions: ["q"] },
        { group: "Bempedoic acid", questions: ["q"] },
      ],
      definitions: [{ term: "ApoB", definition: "d", group: "Cardiovascular Risk" }],
      healthMarkers: { recommended: [{ group: "Cardiovascular Risk", markers: [{ name: "ApoB", rationale: "r" }] }] },
      dataRequisition: [{ type: "Blood", group: "Cardiovascular Risk", items: ["ApoB"] }],
      treatmentGroups: [
        { system: "Cardiovascular Risk", topic: "Lipid-lowering", patient: [], ai: ["Ezetimibe", "Bempedoic acid"] },
        { system: "Metabolic Health", topic: "Precursors", patient: ["Pregnenolone", "Methylation stack"], ai: [] },
      ],
      planAssessmentRows: [{ action: "Tirzepatide", assessment: "a" }],
      basis: fullBasis(),
      generatedAt: "2026-08-23T00:00:00Z",
      inputsHash: "h",
    },
  } as unknown as Client;
}

describe("a realistic assembled Finding is clean", () => {
  it("reports nothing — no false positives on output a real run produces", () => {
    expect(assembledFindingViolations(assembled())).toEqual([]);
  });

  it("reports nothing for a client with no Finding at all", () => {
    expect(assembledFindingViolations({ displayName: "P" } as unknown as Client)).toEqual([]);
  });

  // The phase case, called out on its own so a reviewer sees which rule was excluded and why.
  it("accepts three entries for one drug — one per phase", () => {
    const c = assembled();
    expect(c.finding!.treatment.filter((t) => t.item.startsWith("Rosuvastatin"))).toHaveLength(3);
    expect(assembledFindingViolations(c)).toEqual([]);
  });
});

describe("each rule catches its own corruption", () => {
  it("1 — a body-system tag the Finding does not have", () => {
    const c = assembled();
    c.finding!.noteResults![0].group = "Invented System";
    expect(assembledFindingViolations(c)).toEqual([expect.stringMatching(/noteResults\[0\].*Invented System/)]);
  });

  it("2 — a result orphaned by a deleted row", () => {
    const c = assembled();
    c.factors!.allergies = [];
    expect(assembledFindingViolations(c)).toEqual([expect.stringMatching(/allergyResults: allergyId "al1" matches no row/)]);
  });

  it("3 — a decision with too few bullets, on either side", () => {
    const c = assembled();
    c.finding!.decisions!.patient[0].pros = ["only one"];
    c.finding!.decisions!.ai[0].recommendation = "  ";
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/decisions\.patient\[0\].*pros must be 2-8/),
      expect.stringMatching(/decisions\.ai\[0\].*recommendation is empty/),
    ]);
  });

  it("4 — a planned action with no assessment", () => {
    const c = assembled();
    c.finding!.planAssessmentRows = [];
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/planned action "Tirzepatide 9mg\/week" has no assessment/),
    ]);
  });

  // Found by running this module against the live vault, not invented: two of Pablo's assessment rows
  // named a "Mitochondrial stack" that had since been split into four component supplements.
  it("4 — an assessment row for an action that is no longer planned", () => {
    const c = assembled();
    c.finding!.planAssessmentRows!.push({ action: "Start Mitochondrial stack (TBD)", assessment: "a" });
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/"Start Mitochondrial stack \(TBD\)" assesses an action that is no longer in the Patient Plan/),
    ]);
  });

  // W68 — found by running this module against the live vaults: 19 non-planned treatments across two
  // patients had no assessment at all, rendering under a heading that promises a read with nothing
  // under it. The plan half of this rule existed; this half did not.
  it("4b — an ongoing treatment with no assessment", () => {
    const c = assembled();
    c.factors!.treatments!.push({ id: "t3", name: "Magnesium Glycinate", start: "2025-03" } as never);
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/"Magnesium Glycinate" \(ongoing\) has no assessment/),
    ]);
  });

  it("4b — but a PLANNED treatment is the plan rule's business, not this one", () => {
    // Tirzepatide is planned and has no treatment[] entry; planAssessmentRows covers it. Reporting it
    // here too would double-fault every planned drug on every run.
    const c = assembled();
    expect(c.factors!.treatments!.some((t) => t.name === "Tirzepatide")).toBe(true);
    expect(c.finding!.treatment.some((e) => e.item.startsWith("Tirzepatide"))).toBe(false);
    expect(assembledFindingViolations(c)).toEqual([]);
  });

  it("4b — an assessment for a treatment that was deleted", () => {
    const c = assembled();
    c.finding!.treatment.push({ item: "Ezetimibe 10mg", assessment: "a", group: "Cardiovascular Risk", phase: "ongoing" } as never);
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/"Ezetimibe 10mg" assesses a treatment that is no longer on file/),
    ]);
  });

  it("5 — the AI band out of order, and a stranger in the patient band", () => {
    const c = assembled();
    const dc = c.finding!.doctorConversation;
    const a = dc.findIndex((g) => g.group === "Ezetimibe");
    [dc[a], dc[a + 1]] = [dc[a + 1], dc[a]];
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/AI band position 0 should be "Ezetimibe"/),
      expect.stringMatching(/AI band position 1 should be "Bempedoic acid"/),
    ]);

    const d = assembled();
    d.finding!.doctorConversation[2].group = "Freediving";
    expect(assembledFindingViolations(d)).toEqual([
      expect.stringMatching(/"Freediving" sits in the patient band/),
    ]);
  });

  it("5 — the patient band ORDER, not just its membership", () => {
    // Both names are real patient decisions, so a membership-only check passes this. Only the
    // order-preserving walk catches it — and a transposed band files the wrong questions under the
    // wrong decision, which is the same misattribution class as the note pairing.
    const c = assembled();
    const dc = c.finding!.doctorConversation;
    [dc[2], dc[3]] = [dc[3], dc[2]];
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/"Pregnenolone" sits in the patient band but is not a patient decision in order/),
    ]);
  });

  it("5 — but a patient decision that came back with NO questions is fine", () => {
    // hypothesisEvaluation's merge filters zero-question groups out, so the patient band is a
    // SUBSEQUENCE. This is exactly why the exact-length rule could not be carried over.
    const c = assembled();
    c.finding!.doctorConversation = c.finding!.doctorConversation.filter((g) => g.group !== "Pregnenolone");
    expect(assembledFindingViolations(c)).toEqual([]);
  });

  it("6 — a missing basis sentence", () => {
    const c = assembled();
    (c.finding!.basis as unknown as Record<string, string>).finalThoughts = "";
    expect(assembledFindingViolations(c)).toEqual([expect.stringMatching(/basis\.finalThoughts is empty/)]);
  });

  it("7 — a stale treatmentGroups beside a fresh AI hypothesis", () => {
    // The case validateRegroup structurally cannot see: it only runs when the treatmentGroups leaf
    // SUCCEEDS. If that leaf fails and the run continues, the grouping is stale and Future Treatment
    // silently omits an intervention the Finding recommends.
    const c = assembled();
    c.finding!.decisions!.ai.push(decision("Evolocumab"));
    c.finding!.doctorConversation.push({ group: "Evolocumab", questions: ["q"] });
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/AI intervention "Evolocumab" is in no group/),
    ]);
  });

  it("7 — and one placed twice", () => {
    const c = assembled();
    c.finding!.treatmentGroups![1].ai = ["Ezetimibe"];
    expect(assembledFindingViolations(c)).toEqual([
      expect.stringMatching(/AI intervention "Ezetimibe" is in 2 groups/),
    ]);
  });
});

// The four id-keyed leaves replayed through the real merge, then checked — proving the merge and the
// invariants agree about the assembled shape rather than each being right on its own fixture.
describe("replaying the id-keyed merges leaves a clean Finding", () => {
  it("merges all four and reports nothing", () => {
    let c = assembled();
    for (const [node, idField, id] of [
      ["noteResults", "noteId", "n1"],
      ["allergyResults", "allergyId", "al1"],
      ["familyResults", "familyId", "fh1"],
      ["diseaseResults", "diseaseId", "dx1"],
    ] as const) {
      c = mergeLeafResult(c, node, { items: [{ [idField]: id, result: "regenerated", group: "Cardiovascular Risk" }] });
    }
    expect(c.finding!.noteResults![0].result).toBe("regenerated");
    expect(assembledFindingViolations(c)).toEqual([]);
  });
});
