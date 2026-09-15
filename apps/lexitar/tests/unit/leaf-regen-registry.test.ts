import { describe, it, expect } from "vitest";
import { LEAF_REGEN_SPECS, mergeLabeledItems, labelSubject, buildLeafContext } from "../../src/lib/leaf-regen-registry";
import { CURRENT_DOSE_RULE, CO_MENTION_RULE, BUCKET_DOSE_RULE, STANDARD_DOSING_RULE } from "@pablotech/akesi/treatment-timing-rules";
import { SYSTEM_PROMPT } from "@pablotech/akesi/finding-generate";
import type { RegroupInputs, RegroupResponse } from "@pablotech/akesi/finding-regroup";
import type { Client } from "../../src/lib/types";

function ai(intervention: string, purpose = "") {
  return { intervention, purpose, pros: [], cons: [], alternatives: [], recommendation: "" };
}

// The hypothesisEvaluation LEAF returns questions alongside the evaluation (it owns
// doctorConversation's patient band); the stored decision entry does not carry them. W67 — it must
// also carry a real BODY: 2-8 non-empty bullets per field and non-empty prose, the same numbers
// finding-assemble.ts:298-320 has always demanded of the core path.
function hyp(intervention: string, purpose = "a stated purpose") {
  return {
    intervention,
    purpose,
    pros: ["a benefit", "another benefit"],
    cons: ["a risk", "another risk"],
    alternatives: ["an alternative", "another alternative"],
    recommendation: "Discuss with the prescribing physician.",
    questions: ["ask about it"],
  };
}

function client(): Client {
  return {
    displayName: "Alex",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: {
      decisions: [{ intervention: "Methylation stack", purpose: "overnight HRV" }],
      treatments: [{ name: "Start statin or statin-like approach", kind: "behavior", start: "2099-06" }],
    },
    study: { entries: [{ id: "study-1", focus: "Suspicion", detail: "possible statin intolerance" }] },
    finding: {
      disease: [
        { group: "Cardiovascular Risk", finding: "x" },
        { group: "Methylation / Nutrient Status", finding: "y" },
      ],
      decisions: {
        patient: [{ ...ai("Methylation stack", "overnight HRV"), recommendation: "old recommendation" }],
        ai: [ai("Rosuvastatin", "Cut ApoB"), ai("PCSK9 inhibitor", "Escalation")],
      },
      treatmentGroups: [{ system: "old", topic: "stale group", patient: [], ai: ["old ai item"] }],
      treatment: [{ item: "Ezetimibe 10 mg", assessment: "old assessment", group: "Cardiovascular Risk" }],
      studyResults: [{ study: "Suspicion", result: "old result", group: "Cardiovascular Risk" }],
      noteResults: [{ noteId: "note-1", result: "old note result", group: "Cardiovascular Risk" }],
    },
  } as unknown as Client;
}

// A second client with the noteEntries factors.noteEntries this suite's noteResults block reads from
// (client() above omits them entirely, matching every other fixture's minimal-factors style).
function clientWithNotes(): Client {
  const c = client();
  return { ...c, factors: { ...c.factors, noteEntries: [{ id: "note-1", text: "Woke up with tingling in my left hand." }] } };
}

// M102 — analogous fixture for diseaseResults, same minimal-factors style.
function clientWithDiseases(): Client {
  const c = client();
  return { ...c, factors: { ...c.factors, diseases: [{ id: "dx-1", date: "2026-01-01", diagnostic: "Mild fatty liver" }] } };
}

function validResp(): RegroupResponse {
  return {
    groups: [
      { system: "S1", topic: "Lipid-lowering", patient: ["A1"], ai: ["AI1", "AI2"] },
      { system: "S2", topic: "Methyl donors", patient: ["P1"], ai: [] },
    ],
  };
}

const spec = LEAF_REGEN_SPECS.treatmentGroups;

describe("leaf-regen-registry: treatmentGroups", () => {
  it("registers a spec with the shared tool schema", () => {
    expect(spec).toBeDefined();
    expect((spec.toolSchema as { name: string }).name).toBe("emit_treatment_groups");
  });

  it("buildContext delegates to buildRegroupInputs (id-tagged, not the generic per-key context)", () => {
    const context = spec.buildContext!(client()) as unknown as RegroupInputs;
    expect(context.aiInterventions.map((a) => a.id)).toEqual(["AI1", "AI2"]);
    expect(context.planActions.map((a) => a.id)).toEqual(["A1"]);
  });

  it("isEmpty is true only when patient hypotheses, plan actions, and AI interventions are all empty", () => {
    const empty: RegroupInputs = { systems: [], patientHypotheses: [], planActions: [], aiInterventions: [] };
    expect(spec.isEmpty!(empty as unknown as Record<string, unknown>)).toBe(true);
    const context = spec.buildContext!(client());
    expect(spec.isEmpty!(context)).toBe(false);
  });

  it("validate accepts a well-formed groups array and rejects a malformed payload", () => {
    expect(spec.validate(validResp())).toEqual(validResp());
    expect(() => spec.validate({})).toThrow(/groups missing/);
    expect(() => spec.validate(null)).toThrow(/groups missing/);
  });

  it("mergeInto resolves id-refs back to text and replaces treatmentGroups on a copy of the client", () => {
    const c = client();
    const updated = spec.mergeInto(c, validResp());
    expect(updated.finding!.treatmentGroups).toEqual([
      { system: "Cardiovascular Risk", topic: "Lipid-lowering", patient: ["Start statin or statin-like approach"], ai: ["Rosuvastatin", "PCSK9 inhibitor"] },
      { system: "Methylation / Nutrient Status", topic: "Methyl donors", patient: ["Methylation stack"], ai: [] },
    ]);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.treatmentGroups).toEqual([{ system: "old", topic: "stale group", patient: [], ai: ["old ai item"] }]);
  });

  it("mergeInto throws on an id-coverage violation (deep validation deferred here since validate has no client)", () => {
    const c = client();
    const bad = validResp();
    bad.groups[0].ai = ["AI1"]; // AI2 now unplaced
    expect(() => spec.mergeInto(c, bad)).toThrow(/AI2 is not placed/);
  });
});

const hypSpec = LEAF_REGEN_SPECS.hypothesisEvaluation;

describe("leaf-regen-registry: hypothesisEvaluation", () => {
  it("registers a spec with its own tool schema, using the default generic buildContext", () => {
    expect(hypSpec).toBeDefined();
    expect((hypSpec.toolSchema as { name: string }).name).toBe("emit_hypothesis_evaluation");
    expect(hypSpec.buildContext).toBeUndefined();
  });

  it("isEmpty is true only when patientHypothesis is empty", () => {
    expect(hypSpec.isEmpty!({ patientHypothesis: [] })).toBe(true);
    expect(hypSpec.isEmpty!({ patientHypothesis: [{ intervention: "x", purpose: "y" }] })).toBe(false);
  });

  it("validate accepts a well-formed patient array and rejects a malformed payload", () => {
    const good = { patient: [hyp("Methylation stack", "overnight HRV")] };
    expect(hypSpec.validate(good)).toEqual(good);
    expect(() => hypSpec.validate({})).toThrow(/patient missing/);
    expect(() => hypSpec.validate({ patient: [{ intervention: "x" }] })).toThrow(/FindingDecisionEntry shape/);
  });

  it("mergeInto patches only the matched intervention's entry, leaving decisions.ai untouched, on a copy of the client", () => {
    const c = client();
    const result = { patient: [hyp("Methylation stack", "overnight HRV")] };
    const updated = hypSpec.mergeInto(c, result);
    const { questions: _q, ...stored } = hyp("Methylation stack", "overnight HRV");
    expect(updated.finding!.decisions!.patient).toEqual([stored]);
    expect(updated.finding!.decisions!.ai).toEqual(c.finding!.decisions!.ai);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.decisions!.patient[0].recommendation).toBe("old recommendation");
  });

  it("mergeInto leaves an existing entry untouched when its intervention isn't among the returned items", () => {
    const c = client();
    const result = { patient: [hyp("Some Other Idea", "x")] };
    const updated = hypSpec.mergeInto(c, result);
    expect(updated.finding!.decisions!.patient[0]).toEqual(c.finding!.decisions!.patient[0]);
  });

  it("mergeInto appends a new entry for an intervention with no prior decisions.patient row (e.g. a Hypothesis idea added since the last full regen)", () => {
    const c = client();
    const result = { patient: [hyp("Some Other Idea", "x")] };
    const updated = hypSpec.mergeInto(c, result);
    const { questions: _q, ...appended } = hyp("Some Other Idea", "x");
    expect(updated.finding!.decisions!.patient).toEqual([c.finding!.decisions!.patient[0], appended]);
  });
});

const planSpec = LEAF_REGEN_SPECS.aiOnPlan;

describe("leaf-regen-registry: aiOnPlan", () => {
  it("registers a spec with its own tool schema, using the default generic buildContext", () => {
    expect(planSpec).toBeDefined();
    expect((planSpec.toolSchema as { name: string }).name).toBe("emit_plan_assessment_rows");
    expect(planSpec.buildContext).toBeUndefined();
  });

  it("isEmpty is true only when patientPlan is empty", () => {
    expect(planSpec.isEmpty!({ patientPlan: [] })).toBe(true);
    expect(planSpec.isEmpty!({ patientPlan: [{ name: "Start statin" }] })).toBe(false);
  });

  it("validate accepts a well-formed rows array and rejects a malformed payload", () => {
    const good = { rows: [{ action: "Start statin", assessment: "Reasonable given ApoB." }] };
    expect(planSpec.validate(good)).toEqual(good);
    expect(() => planSpec.validate({})).toThrow(/rows missing/);
    expect(() => planSpec.validate({ rows: [{ action: "x" }] })).toThrow(/action, assessment/);
  });

  it("mergeInto replaces finding.planAssessmentRows on a copy of the client", () => {
    const c = client();
    const result = { rows: [{ action: "Start statin or statin-like approach", assessment: "Well-timed." }] };
    const updated = planSpec.mergeInto(c, result);
    expect(updated.finding!.planAssessmentRows).toEqual(result.rows);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.planAssessmentRows).toBeUndefined();
  });

});

// M66 P8 — these two are the only e2e-untestable-for-content leaf-regen specs (mergeInto matches by
// an EXACT existing item/study label, which an e2e test can't construct without reading the private
// vault fixture's raw finding.treatment/studyResults strings); covered here instead.
const taSpec = LEAF_REGEN_SPECS.treatmentAssessment;

describe("leaf-regen-registry: treatmentAssessment", () => {
  it("registers a spec with its own tool schema, using the default generic buildContext", () => {
    expect(taSpec).toBeDefined();
    expect((taSpec.toolSchema as { name: string }).name).toBe("emit_treatment_assessment");
    expect(taSpec.buildContext).toBeUndefined();
  });

  it("isEmpty is true only when treatmentHistory is empty", () => {
    expect(taSpec.isEmpty!({ treatmentHistory: [] })).toBe(true);
    expect(taSpec.isEmpty!({ treatmentHistory: [{ name: "Ezetimibe" }] })).toBe(false);
  });

  // W82 — this leaf was reading raw dose fields and had no computed daily ingredient total to reason
  // from, the same gap chat-context.ts had. Each row keeps its own id/shape (the id-lookup and
  // isEmpty checks above depend on that) — dailyTotal is only ever an ADDITION to a row.
  it("attaches a computed dailyTotal to AM+PM ongoing rows of the same medicine, not just one", () => {
    const c = client();
    const administration = { unit: "capsule", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" as const };
    const ingredients = [{ name: "Magnesium", amount: 120, unit: "mg", form: "as magnesium glycinate" }];
    c.factors!.treatments!.push(
      {
        id: "m1", name: "Magnesium (glycinate)", kind: "supplement", start: "2026-08-01", timingPeriod: "AM",
        doseAmount: 1, doseUnit: "capsule", doseFrequency: "day", administration, ingredients,
      },
      {
        id: "m2", name: "Magnesium (glycinate)", kind: "supplement", start: "2026-08-01", timingPeriod: "PM",
        doseAmount: 1, doseUnit: "capsule", doseFrequency: "day", administration, ingredients,
      },
    );
    const context = buildLeafContext("treatmentAssessment", c);
    const history = context.treatmentHistory as { id: string; dailyTotal?: unknown }[];
    const am = history.find((t) => t.id === "m1");
    const pm = history.find((t) => t.id === "m2");
    expect(am?.dailyTotal).toEqual([{ name: "Magnesium", amountPerDay: 240, unit: "mg", form: "as magnesium glycinate" }]);
    expect(pm?.dailyTotal).toEqual(am?.dailyTotal);
  });

  it("tells the model to use dailyTotal directly rather than re-deriving one", () => {
    expect(taSpec.systemPromptExtra).toMatch(/dailyTotal/);
  });

  it("validate accepts a well-formed items array and rejects a malformed payload", () => {
    const good = { items: [{ treatmentId: "ez-1", item: "Ezetimibe 10 mg", assessment: "Holding ApoB down.", group: "Cardiovascular Risk" }] };
    expect(taSpec.validate(good)).toEqual(good);
    expect(() => taSpec.validate({})).toThrow(/items missing/);
    expect(() => taSpec.validate({ items: [{ item: "x" }] })).toThrow(/item, assessment, group/);
  });

  // W71 — this section was the last one still paired by a NAME the model writes itself, with the dose
  // appended. treatment-bucket.ts took 25 changes in 403 lines building substring rules around that;
  // the id is what removes the guessing.
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

    // Regression: every real API response carries a real `phase` (the tool schema requires it), while
    // a row written before phase existed has `phase: undefined` on disk. The stamp step used to require
    // `i.phase === row.phase`, which compares a real value against undefined and can never be true —
    // so a pre-phase row could never be stamped, never keyed to match an incoming item, and every
    // regen silently appended an invisible duplicate while the visible (first-matched) row stayed
    // frozen forever. The fixture above omits `phase` on the returned item too, which is why it kept
    // passing throughout — this one sends the shape Anthropic actually returns.
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

  // W68 — three blocks of `expect(prompt).toMatch(/phrase/)` were deleted here. Each typed a phrase
  // into the test and matched it against the same phrase in the prompt: a deletion detector, not a
  // test. Four of the phrases (CO-MENTION DISCIPLINE, IT EXISTS AS ITS OWN ROW, WINDOW OVERLAPS,
  // ONGOING) are already covered for real further down, by the shared-constant parity suite — both
  // sides there interpolate the SAME imported constant, so it catches actual drift. The rest state
  // clinical requirements about prose quality (synergy, cofactor, deemphasis commentary) that no code
  // can check; the rule's home is the prompt constant and its comment, not a test that restates it.

  // Regression: an assessment called a glutathione stack's NAC "concurrent" when no separate NAC row
  // was active — the name of ANOTHER entry ("Glutathione stack (Glycine 20g/day and NAC 2g/day)") was
  // read as evidence of a treatment. A co-mention must be dated, and sourced from a real row.
  // Regression: a drug mid-titration was described at 6mg when 9mg was active, because the prompt
  // defined the current dose as the latest-dated row — which is a SCHEDULED FUTURE step whenever one
  // exists. The current dose is the row whose window contains today, closed range or not.
  it("system prompt defines the current dose as the row whose window contains today, not the newest row", () => {
    expect(taSpec.systemPromptExtra).toContain(CURRENT_DOSE_RULE);
    expect(taSpec.systemPromptExtra).not.toMatch(/closed-range rows are past doses, not the present/);
    expect(taSpec.systemPromptExtra).not.toMatch(/most-recently-dated row/);
  });

  // Regression: a PAST card was described as "ongoing since August 2025" with "the current 6 mg/week
  // dose" — present tense and a current dose for a regimen that had ended. And a bucket holds many
  // rows (Tirzepatide's past alone has nine), so naming one of them "the dose" discards the
  // trajectory that is the actual content.
  it("system prompt forbids present tense for past regimens and reads a bucket as a trajectory", () => {
    expect(taSpec.systemPromptExtra).toContain(BUCKET_DOSE_RULE);
    expect(taSpec.systemPromptExtra).toMatch(/DOSE IN CONTEXT/);
    expect(BUCKET_DOSE_RULE).toMatch(/NEVER use .*current/);
    expect(BUCKET_DOSE_RULE).toMatch(/Never pick one row and call it/);
  });

  it("system prompt places a dose against the drug's standard range", () => {
    expect(taSpec.systemPromptExtra).toContain(STANDARD_DOSING_RULE);
    expect(STANDARD_DOSING_RULE).toMatch(/2\.5 mg\/week/);
    expect(STANDARD_DOSING_RULE).toMatch(/15 mg\/week/);
    // A wrong ceiling is worse than no ceiling.
    expect(STANDARD_DOSING_RULE).toMatch(/say nothing about it rather than guessing/);
  });

  it("system prompt forbids an undated co-mention and inferring a treatment from another entry's name", () => {
    expect(taSpec.systemPromptExtra).toMatch(/CO-MENTION DISCIPLINE/);
    expect(taSpec.systemPromptExtra).toMatch(/IT EXISTS AS ITS OWN ROW/);
    expect(taSpec.systemPromptExtra).toMatch(/Never infer a treatment from words inside another entry/);
    expect(taSpec.systemPromptExtra).toMatch(/WINDOW OVERLAPS/);
    expect(taSpec.systemPromptExtra).toMatch(/NEVER write "concurrent"/);
  });
});

// The bug that made re-translating look like a dead button: these labels carry the dose, so a regen
// that re-reads the dose answers under a drifted label, which used to append beside the stale entry
// while every reader kept finding the stale one first.
describe("leaf-regen-registry: superseding a drifted label", () => {
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

const srSpec = LEAF_REGEN_SPECS.studyResults;

describe("leaf-regen-registry: studyResults", () => {
  it("registers a spec with its own tool schema, using the default generic buildContext", () => {
    expect(srSpec).toBeDefined();
    expect((srSpec.toolSchema as { name: string }).name).toBe("emit_study_results");
    expect(srSpec.buildContext).toBeUndefined();
  });

  it("isEmpty is true only when entries are absent", () => {
    expect(srSpec.isEmpty!({ pursuedStudy: {} })).toBe(true);
    expect(srSpec.isEmpty!({ pursuedStudy: { entries: [] } })).toBe(true);
    expect(srSpec.isEmpty!({ pursuedStudy: { entries: [{ focus: "Selection", detail: "y" }] } })).toBe(false);
  });

  it("validate accepts a well-formed items array and rejects a malformed payload", () => {
    const good = { items: [{ study: "Suspicion", result: "Consistent with early insulin resistance.", group: "Cardiovascular Risk" }] };
    expect(srSpec.validate(good)).toEqual(good);
    expect(() => srSpec.validate({})).toThrow(/items missing/);
    expect(() => srSpec.validate({ items: [{ study: "x" }] })).toThrow(/study, result, group/);
  });

  it("mergeInto updates only the matched study label's result, leaving study/group and unmatched entries untouched", () => {
    const c = client();
    const result = { items: [{ study: "Suspicion", result: "Refreshed read.", group: "Cardiovascular Risk" }] };
    const updated = srSpec.mergeInto(c, result);
    expect(updated.finding!.studyResults).toEqual([{ study: "Suspicion", result: "Refreshed read.", group: "Cardiovascular Risk" }]);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.studyResults![0].result).toBe("old result");
  });

  it("mergeInto leaves an existing entry untouched when its study label isn't among the returned items", () => {
    const c = client();
    const result = { items: [{ study: "Symptoms", result: "x", group: "Cardiovascular Risk" }] };
    const updated = srSpec.mergeInto(c, result);
    expect(updated.finding!.studyResults![0]).toEqual(c.finding!.studyResults![0]);
  });

  it("mergeInto appends a new entry for a study label with no prior finding.studyResults row (e.g. a Study added since the last full regen)", () => {
    const c = client();
    const result = { items: [{ study: "Symptoms", result: "Newly generated read.", group: "Cardiovascular Risk" }] };
    const updated = srSpec.mergeInto(c, result);
    expect(updated.finding!.studyResults).toEqual([
      { study: "Suspicion", result: "old result", group: "Cardiovascular Risk" },
      { study: "Symptoms", result: "Newly generated read.", group: "Cardiovascular Risk" },
    ]);
  });
});

const nrSpec = LEAF_REGEN_SPECS.noteResults;
const dsSpec = LEAF_REGEN_SPECS.diseaseResults;

describe("leaf-regen-registry: noteResults", () => {
  it("registers a spec with its own tool schema; no scopedArrayKey (row-scoping uses buildContext filtering, not the content-based SCOPE OVERRIDE mechanism)", () => {
    expect(nrSpec).toBeDefined();
    expect((nrSpec.toolSchema as { name: string }).name).toBe("emit_note_results");
    expect(nrSpec.scopedArrayKey).toBeUndefined();
  });

  // M-translate — a row-level Translate click passes targetIds so the model only ever sees the one
  // note; without targetIds, buildContext is unscoped (every populated note), same as before.
  it("buildContext without targetIds returns every populated note", () => {
    const c = clientWithNotes();
    const context = nrSpec.buildContext!(c);
    expect(context.pursuedNotes).toEqual([{ id: "note-1", text: "Woke up with tingling in my left hand." }]);
  });

  it("buildContext with targetIds filters pursuedNotes down to just those ids", () => {
    const c = clientWithNotes();
    const withSecondNote: Client = {
      ...c,
      factors: {
        ...c.factors,
        noteEntries: [
          { id: "note-1", text: "Woke up with tingling in my left hand." },
          { id: "note-2", text: "Second note." },
        ],
      },
    } as unknown as Client;
    const context = nrSpec.buildContext!(withSecondNote, ["note-2"]);
    expect(context.pursuedNotes).toEqual([{ id: "note-2", text: "Second note." }]);
  });

  it("isEmpty is true only when there are no populated notes", () => {
    expect(nrSpec.isEmpty!({ pursuedNotes: [] })).toBe(true);
    expect(nrSpec.isEmpty!({ pursuedNotes: [{ id: "note-1", text: "some note" }] })).toBe(false);
  });

  it("validate requires the echoed noteId alongside result and group", () => {
    const good = { items: [{ noteId: "note-1", result: "Nothing here connects to a lab finding.", group: "Cardiovascular Risk" }] };
    expect(nrSpec.validate(good)).toEqual(good);
    expect(() => nrSpec.validate({})).toThrow(/items missing/);
    expect(() => nrSpec.validate({ items: [{ result: "x" }] })).toThrow(/noteId, result, group/);
    // W67 — the id is what pairs the answer to its note; a response without it used to be accepted
    // and silently position-paired.
    expect(() => nrSpec.validate({ items: [{ result: "x", group: "Cardiovascular Risk" }] })).toThrow(/noteId, result, group/);
  });

  it("mergeInto pairs the returned item to its note by the ECHOED id and updates only that entry's result", () => {
    const c = clientWithNotes();
    const result = { items: [{ noteId: "note-1", result: "Refreshed read.", group: "Cardiovascular Risk" }] };
    const updated = nrSpec.mergeInto(c, result);
    expect(updated.finding!.noteResults).toEqual([{ noteId: "note-1", result: "Refreshed read.", group: "Cardiovascular Risk" }]);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.noteResults![0].result).toBe("old note result");
  });

  it("mergeInto appends a new entry for a note with no prior finding.noteResults row (e.g. a Note added since the last full regen)", () => {
    const c = client();
    const withSecondNote: Client = {
      ...c,
      factors: {
        ...c.factors,
        noteEntries: [
          { id: "note-1", text: "Woke up with tingling in my left hand." },
          { id: "note-2", text: "New note since the last regen." },
        ],
      },
    } as unknown as Client;
    // Deliberately returned in REVERSE order: the ids decide where each answer lands, so a response
    // the model happens to order differently must still be correct. Under position pairing this
    // exact payload filed each answer against the wrong note.
    const result = {
      items: [
        { noteId: "note-2", result: "Newly generated read.", group: "Cardiovascular Risk" },
        { noteId: "note-1", result: "old note result", group: "Cardiovascular Risk" },
      ],
    };
    const updated = nrSpec.mergeInto(withSecondNote, result);
    expect(updated.finding!.noteResults).toEqual([
      { noteId: "note-1", result: "old note result", group: "Cardiovascular Risk" },
      { noteId: "note-2", result: "Newly generated read.", group: "Cardiovascular Risk" },
    ]);
  });

  // M-translate — a scoped response is length-1 regardless of which note it's for. It carries its own
  // noteId now, so it lands correctly without the merge being told which row was targeted; a Translate
  // click on note-2 can no longer overwrite note-1.
  it("a scoped one-item response lands on its own note, with no targetIds passed to the merge", () => {
    const c = clientWithNotes();
    const withSecondNote: Client = {
      ...c,
      factors: {
        ...c.factors,
        noteEntries: [
          { id: "note-1", text: "Woke up with tingling in my left hand." },
          { id: "note-2", text: "Second note." },
        ],
      },
    } as unknown as Client;
    const result = { items: [{ noteId: "note-2", result: "Refreshed read for note-2 only.", group: "Cardiovascular Risk" }] };
    const updated = nrSpec.mergeInto(withSecondNote, result);
    expect(updated.finding!.noteResults).toEqual([
      { noteId: "note-1", result: "old note result", group: "Cardiovascular Risk" },
      { noteId: "note-2", result: "Refreshed read for note-2 only.", group: "Cardiovascular Risk" },
    ]);
  });
});

// M-translate — analogous fixtures for allergyResults/familyResults, same minimal-factors style as
// clientWithNotes above.
function clientWithAllergies(): Client {
  const c = client();
  return { ...c, factors: { ...c.factors, allergies: [{ id: "allergy-1", allergen: "Penicillin", reaction: "Hives" }] } };
}
function clientWithFamilyHistory(): Client {
  const c = client();
  return { ...c, factors: { ...c.factors, familyHistory: [{ id: "family-1", relation: "Mother", condition: "Type 2 diabetes" }] } };
}

const arSpec = LEAF_REGEN_SPECS.allergyResults;
const frSpec = LEAF_REGEN_SPECS.familyResults;

describe("leaf-regen-registry: allergyResults", () => {
  it("registers a spec with its own tool schema; no scopedArrayKey (row-scoping uses buildContext filtering)", () => {
    expect(arSpec).toBeDefined();
    expect((arSpec.toolSchema as { name: string }).name).toBe("emit_allergy_results");
    expect(arSpec.scopedArrayKey).toBeUndefined();
  });

  it("buildContext with targetIds filters patientAllergies down to just those ids", () => {
    const c = clientWithAllergies();
    const withSecond: Client = {
      ...c,
      factors: { ...c.factors, allergies: [...c.factors!.allergies!, { id: "allergy-2", allergen: "Sulfa", reaction: "Rash" }] },
    } as unknown as Client;
    expect(arSpec.buildContext!(withSecond).patientAllergies).toEqual(withSecond.factors!.allergies);
    expect(arSpec.buildContext!(withSecond, ["allergy-2"]).patientAllergies).toEqual([{ id: "allergy-2", allergen: "Sulfa", reaction: "Rash" }]);
  });

  it("a scoped one-item response lands on its own allergy via the echoed id", () => {
    const c = clientWithAllergies();
    const withSecond: Client = {
      ...c,
      factors: { ...c.factors, allergies: [...c.factors!.allergies!, { id: "allergy-2", allergen: "Sulfa", reaction: "Rash" }] },
      finding: { ...c.finding!, allergyResults: [{ allergyId: "allergy-1", result: "old", group: "Cardiovascular Risk" }] },
    } as unknown as Client;
    const result = { items: [{ allergyId: "allergy-2", result: "Refreshed read for allergy-2 only.", group: "Cardiovascular Risk" }] };
    const updated = arSpec.mergeInto(withSecond, result);
    expect(updated.finding!.allergyResults).toEqual([
      { allergyId: "allergy-1", result: "old", group: "Cardiovascular Risk" },
      { allergyId: "allergy-2", result: "Refreshed read for allergy-2 only.", group: "Cardiovascular Risk" },
    ]);
  });
});

describe("leaf-regen-registry: familyResults", () => {
  it("registers a spec with its own tool schema; no scopedArrayKey (row-scoping uses buildContext filtering)", () => {
    expect(frSpec).toBeDefined();
    expect((frSpec.toolSchema as { name: string }).name).toBe("emit_family_results");
    expect(frSpec.scopedArrayKey).toBeUndefined();
  });

  it("buildContext with targetIds filters patientFamilyHistory down to just those ids", () => {
    const c = clientWithFamilyHistory();
    const withSecond: Client = {
      ...c,
      factors: { ...c.factors, familyHistory: [...c.factors!.familyHistory!, { id: "family-2", relation: "Father", condition: "Hypertension" }] },
    } as unknown as Client;
    expect(frSpec.buildContext!(withSecond).patientFamilyHistory).toEqual(withSecond.factors!.familyHistory);
    expect(frSpec.buildContext!(withSecond, ["family-2"]).patientFamilyHistory).toEqual([{ id: "family-2", relation: "Father", condition: "Hypertension" }]);
  });

  it("a scoped one-item response lands on its own family entry via the echoed id", () => {
    const c = clientWithFamilyHistory();
    const withSecond: Client = {
      ...c,
      factors: { ...c.factors, familyHistory: [...c.factors!.familyHistory!, { id: "family-2", relation: "Father", condition: "Hypertension" }] },
      finding: { ...c.finding!, familyResults: [{ familyId: "family-1", result: "old", group: "Cardiovascular Risk" }] },
    } as unknown as Client;
    const result = { items: [{ familyId: "family-2", result: "Refreshed read for family-2 only.", group: "Cardiovascular Risk" }] };
    const updated = frSpec.mergeInto(withSecond, result);
    expect(updated.finding!.familyResults).toEqual([
      { familyId: "family-1", result: "old", group: "Cardiovascular Risk" },
      { familyId: "family-2", result: "Refreshed read for family-2 only.", group: "Cardiovascular Risk" },
    ]);
  });
});

describe("leaf-regen-registry: diseaseResults", () => {
  it("registers a spec with its own tool schema and the shared row-scoping buildContext", () => {
    expect(dsSpec).toBeDefined();
    expect((dsSpec.toolSchema as { name: string }).name).toBe("emit_disease_results");
    // W67 — this used to be the one id-keyed row leaf with no buildContext, so a row-scoped Translate
    // on a diagnosis silently ran unscoped over every diagnosis.
    expect(dsSpec.buildContext).toBeDefined();
    expect(dsSpec.scopedArrayKey).toBeUndefined();
  });

  it("isEmpty is true only when there are no diagnoses on file", () => {
    expect(dsSpec.isEmpty!({ diagnosedDisease: [] })).toBe(true);
    expect(dsSpec.isEmpty!({ diagnosedDisease: [{ id: "dx-1", date: "2026-01-01", diagnostic: "Mild fatty liver" }] })).toBe(false);
  });

  it("validate requires the echoed diseaseId alongside result and group", () => {
    const good = { items: [{ diseaseId: "dx-1", result: "Consistent with existing lipid findings.", group: "Cardiovascular Risk" }] };
    expect(dsSpec.validate(good)).toEqual(good);
    expect(() => dsSpec.validate({})).toThrow(/items missing/);
    expect(() => dsSpec.validate({ items: [{ result: "x" }] })).toThrow(/diseaseId, result, group/);
  });

  it("mergeInto pairs the returned item to its diagnosis by the ECHOED id and updates only that entry's result", () => {
    const c = clientWithDiseases();
    const result = { items: [{ diseaseId: "dx-1", result: "Refreshed read.", group: "Cardiovascular Risk" }] };
    const updated = dsSpec.mergeInto(c, result);
    expect(updated.finding!.diseaseResults).toEqual([{ diseaseId: "dx-1", result: "Refreshed read.", group: "Cardiovascular Risk" }]);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.diseaseResults).toBeUndefined();
  });

  it("mergeInto appends a new entry for a diagnosis with no prior finding.diseaseResults row (e.g. a Report added since the last full regen)", () => {
    const c = clientWithDiseases();
    const withSecondDisease: Client = {
      ...c,
      factors: {
        ...c.factors,
        diseases: [
          { id: "dx-1", date: "2026-01-01", diagnostic: "Mild fatty liver" },
          { id: "dx-2", date: "2026-02-01", diagnostic: "New diagnosis since the last regen" },
        ],
      },
    } as unknown as Client;
    const result = {
      items: [
        { diseaseId: "dx-1", result: "Prior read.", group: "Cardiovascular Risk" },
        { diseaseId: "dx-2", result: "Newly generated read.", group: "Cardiovascular Risk" },
      ],
    };
    const updated = dsSpec.mergeInto(withSecondDisease, result);
    expect(updated.finding!.diseaseResults).toEqual([
      { diseaseId: "dx-1", result: "Prior read.", group: "Cardiovascular Risk" },
      { diseaseId: "dx-2", result: "Newly generated read.", group: "Cardiovascular Risk" },
    ]);
  });
});

// The whole-Finding "↻ Translate" (Provider Access pulldown) regenerates through the MONOLITH prompt,
// not these per-node ones. Both carried their own copy of the timing rules, so correcting one left
// the other free to reintroduce the same errors on the next full regeneration. They now share one
// source; this asserts neither path can drift from it again.
describe("treatment timing rules are shared by both prompt paths", () => {
  const monolith = SYSTEM_PROMPT;

  // W65 — the co-mention rule is no longer in the monolith, and that is the POINT: the `treatment`
  // section it belonged to was cut, so treatmentAssessment's leaf prompt is now its only home. The
  // shared-constant guarantee changes shape here from "both copies agree" to "there is one copy".
  it("the co-mention rule lives in the leaf prompt only, now that the monolith has no treatment section", () => {
    const unwrap = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(unwrap(LEAF_REGEN_SPECS.treatmentAssessment.systemPromptExtra)).toContain(unwrap(CO_MENTION_RULE));
    expect(unwrap(monolith)).not.toContain(unwrap(CO_MENTION_RULE));
    // The monolith keeps CURRENT_DOSE_RULE: it still describes the treatment HISTORY it is given as
    // input (treatmentHistory), even though it no longer writes the treatment section.
    expect(unwrap(monolith)).toContain(unwrap(CURRENT_DOSE_RULE));
  });

  // The duplication these constants exist to prevent: a correction landing in one prompt path and
  // silently missing the other.
  it("the monolith Finding prompt carries the same bucket-tense and standard-dosing rules", () => {
    const unwrap = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(unwrap(monolith)).toContain(unwrap(BUCKET_DOSE_RULE));
    expect(unwrap(monolith)).toContain(unwrap(STANDARD_DOSING_RULE));
  });

  it("neither prompt path still defines the current dose as the newest row", () => {
    for (const p of [monolith, LEAF_REGEN_SPECS.treatmentAssessment.systemPromptExtra]) {
      expect(p).not.toMatch(/closed-range rows are past doses, not the present/);
      expect(p).not.toMatch(/most-recently-dated row/);
    }
  });
});

// The divergence this milestone removes: aiOnPlan — the ONE spec that handles planned items — never
// received the canonical planned-tense wording or any dose yardstick, while treatmentAssessment
// (which does not need the planned clause) had all of them.
describe("both treatment-facing prompts carry the same rules", () => {
  it("aiOnPlan now gets the bucket-tense and standard-dosing rules too", () => {
    const plan = LEAF_REGEN_SPECS.aiOnPlan.systemPromptExtra;
    expect(plan).toContain(BUCKET_DOSE_RULE);
    expect(plan).toContain(STANDARD_DOSING_RULE);
    expect(plan).toContain(CO_MENTION_RULE);
  });

  it("treatmentAssessment answers per (drug, phase), not once per drug", () => {
    const ta = LEAF_REGEN_SPECS.treatmentAssessment.systemPromptExtra;
    expect(ta).toMatch(/ONE ENTRY PER \(DRUG, PHASE\)/);
    expect(ta).toMatch(/yields THREE entries/);
    // The old contract said the opposite, and would have suppressed two of the three.
    expect(ta).not.toMatch(/Never emit two entries with the same drug name\. /);
  });
});
