import { describe, it, expect } from "vitest";
import { mergeLeafResult, LEAF_REGEN_SPECS, leafContextFor } from "../../src/lib/leaf-regen-registry";
import type { Client } from "../../src/lib/types";

// W65 — validate() in finding-assemble.ts enforces these while the MONOLITH writes the section.
// Once the leaf owns it that check no longer runs on a refresh, so it has to live in the merge.
// These tests are the record of that move: delete the merge check and one of them fails.
const base = (over: Partial<Client> = {}) =>
  ({
    displayName: "Pablo",
    results: [],
    watchlist: [],
    factors: { treatments: [] },
    finding: { disease: [{ group: "Cardiovascular Risk", finding: "x" }] },
    ...over,
  }) as unknown as Client;

describe("studyResults merge: body-system tags", () => {
  it("rejects a group that is not one of the Finding's disease groups", () => {
    expect(() =>
      mergeLeafResult(base(), "studyResults", { items: [{ study: "S", result: "r", group: "Invented System" }] }),
    ).toThrow(/not one of the current disease groups/);
  });

  it("accepts a real one", () => {
    const out = mergeLeafResult(base(), "studyResults", {
      items: [{ study: "S", result: "r", group: "Cardiovascular Risk" }],
    });
    expect(out.finding!.studyResults).toHaveLength(1);
  });
});

// W75 — studyResults had NO checkAgainstInput at all: it was the only content-labelled row leaf
// without one, so a fabricated `study` label merged in as a brand-new row (mergeLabeledItems appends
// what it cannot match) and a row the model skipped stayed unanswered with nothing saying so.
describe("studyResults: answers must name real Pursued Study rows, all of them, once each", () => {
  const withStudy = (...focuses: string[]) =>
    base({ study: { entries: focuses.map((focus, i) => ({ id: `s${i}`, focus, detail: "d" })) } } as unknown as Partial<Client>);
  const check = (client: Client, studies: string[], targetLabels?: string[]) =>
    LEAF_REGEN_SPECS.studyResults.checkAgainstInput!(
      leafContextFor("studyResults", client),
      { items: studies.map((study) => ({ study, result: "r", group: "Cardiovascular Risk" })) },
      targetLabels,
    );

  it("rejects a study row the patient never pursued", () => {
    expect(() => check(withStudy("Effect"), ["Selection"])).toThrow(/is not one of the 1 study rows/);
  });

  it("rejects a pursued row left unanswered", () => {
    expect(() => check(withStudy("Effect", "Presence"), ["Effect"])).toThrow(/1 of 2 study rows went unanswered/);
  });

  it("rejects the same row answered twice", () => {
    expect(() => check(withStudy("Effect"), ["Effect", "Effect"])).toThrow(/appears more than once/);
  });

  it("accepts a complete set", () => {
    expect(() => check(withStudy("Effect", "Presence"), ["Presence", "Effect"])).not.toThrow();
  });

  // A row-level Translate sends a SCOPE OVERRIDE and is asked for that row only. Without narrowing
  // the expected set to the scope, coverage would fail every scoped request — the check would be
  // strictly worse than not having one.
  it("narrows coverage to the scope a row-level Translate asked for", () => {
    expect(() => check(withStudy("Effect", "Presence"), ["Effect"], ["Effect"])).not.toThrow();
    expect(() => check(withStudy("Effect", "Presence"), ["Presence"], ["Effect"])).toThrow(/is not one of the 1 study rows/);
  });
});

// W67 — these checks moved from mergeInto to checkAgainstInput. They compare against the PLAN THE
// MODEL SAW, not the merge-time client: applyLeafRegen merges onto whatever is live at save time, so
// a plan action added between fetch and apply used to throw on a perfectly good response.
describe("aiOnPlan: rows must name real Patient Plan actions", () => {
  const check = (client: Client, rows: { action: string; assessment: string }[]) =>
    LEAF_REGEN_SPECS.aiOnPlan.checkAgainstInput!(leafContextFor("aiOnPlan", client), { rows });

  // patientPlan derives from FUTURE-dated treatments, so a planned one is what makes an action real.
  const withPlan = () =>
    base({
      factors: { treatments: [{ id: "t1", name: "Pregnenolone", start: "2099-01-15" }] },
    } as unknown as Partial<Client>);

  it("rejects an action the patient never planned", () => {
    expect(() => check(withPlan(), [{ action: "Take up freediving", assessment: "a" }])).toThrow(
      /matches no Patient Plan action/,
    );
  });

  it("rejects a planned action left unassessed — the coverage rule no leaf ever re-made", () => {
    const c = base({
      factors: {
        treatments: [
          { id: "t1", name: "Pregnenolone", start: "2099-01-15" },
          { id: "t2", name: "Tesamorelin", start: "2099-02-15" },
        ],
      },
    } as unknown as Partial<Client>);
    expect(() => check(c, [{ action: "Pregnenolone", assessment: "a" }])).toThrow(
      /1 planned action\(s\) went unassessed \(Tesamorelin\)/,
    );
  });

  it("does not fault a response for a plan row added after the request went out", () => {
    const asked = leafContextFor("aiOnPlan", withPlan());
    const later = base({
      factors: {
        treatments: [
          { id: "t1", name: "Pregnenolone", start: "2099-01-15" },
          { id: "t2", name: "Added while the model was thinking", start: "2099-03-15" },
        ],
      },
    } as unknown as Partial<Client>);
    // The check is against `asked`; merging onto the newer client must still succeed.
    expect(() =>
      LEAF_REGEN_SPECS.aiOnPlan.checkAgainstInput!(asked, { rows: [{ action: "Pregnenolone", assessment: "a" }] }),
    ).not.toThrow();
    expect(() => mergeLeafResult(later, "aiOnPlan", { rows: [{ action: "Pregnenolone", assessment: "a" }] })).not.toThrow();
  });

  // W65 — the case a live run actually produced: patientPlan hands the leaf raw treatment objects,
  // so the model answers with the drug name while the canonical label carries the dose too.
  it("accepts the bare drug name for a dose-annotated planned action", () => {
    const c = base({ factors: { treatments: [{ id: "t1", name: "Tirzepatide", doseAmount: 9, doseUnit: "mg", doseFrequency: "week", start: "2099-01-15" }] } } as unknown as Partial<Client>);
    expect(() => check(c, [{ action: "Tirzepatide", assessment: "a" }])).not.toThrow();
    const out = mergeLeafResult(c, "aiOnPlan", { rows: [{ action: "Tirzepatide", assessment: "a" }] });
    expect(out.finding!.planAssessmentRows).toHaveLength(1);
  });

  it("accepts a real planned action", () => {
    expect(() => check(withPlan(), [{ action: "Pregnenolone", assessment: "a" }])).not.toThrow();
    const out = mergeLeafResult(withPlan(), "aiOnPlan", { rows: [{ action: "Pregnenolone", assessment: "a" }] });
    expect(out.finding!.planAssessmentRows).toHaveLength(1);
  });

  // The label is asserted real by the test above, so this can only fail on the DUPLICATE check —
  // no `|| matches no Patient Plan action` escape hatch that would pass for the wrong reason.
  it("rejects the same action twice", () => {
    expect(() =>
      check(withPlan(), [{ action: "Pregnenolone", assessment: "a" }, { action: "Pregnenolone", assessment: "b" }]),
    ).toThrow(/appears more than once/);
  });
});

// W65 — the convention this milestone's last bug turned on, recorded from a real run's output.
//
// The two treatment-facing leaves answer with DIFFERENT label conventions, because their contexts
// differ: treatmentAssessment is given `treatmentHistory` (dose-bearing objects) and answers with
// dosed labels — a real run returned "Tirzepatide 9mg/week", "Rosuvastatin 20mg/day". aiOnPlan is
// given `patientPlan` (also objects, but nothing asks it for the dose) and answers with the bare
// name — the same run returned "Tirzepatide".
//
// So a merge check written against one leaf's convention is wrong for the other. Both are accepted
// here, which is the invariant worth freezing; neither leaf may start rejecting what it produces.
describe("the two treatment leaves use different label conventions, and both merges accept theirs", () => {
  const planned = (name: string) =>
    base({
      factors: { treatments: [{ id: "t1", name, doseAmount: 9, doseUnit: "mg", doseFrequency: "week", start: "2099-01-15" }] },
    } as unknown as Partial<Client>);

  it("treatmentAssessment accepts a DOSED item label", () => {
    const out = mergeLeafResult(planned("Zeptaglutide"), "treatmentAssessment", {
      items: [{ item: "Zeptaglutide 9mg/week", assessment: "a", group: "Cardiovascular Risk" }],
    });
    expect(out.finding!.treatment?.some((t) => t.item === "Zeptaglutide 9mg/week")).toBe(true);
  });

  it("aiOnPlan accepts the BARE name for that same treatment", () => {
    const out = mergeLeafResult(planned("Zeptaglutide"), "aiOnPlan", {
      rows: [{ action: "Zeptaglutide", assessment: "a" }],
    });
    expect(out.finding!.planAssessmentRows).toHaveLength(1);
  });
});

describe("hypothesisEvaluation refills doctorConversation's patient band (W65 residue)", () => {
  // The core emits decisions.patient as an empty array, so it also emits ZERO patient-decision
  // groups in doctorConversation. Measured on a real refresh: 4 patient hypotheses, 0 groups. The
  // leaf that fills decisions.patient now fills their questions too.
  function coreClient(): Client {
    return {
      displayName: "P",
      dob: "1980-01-01",
      gender: "male",
      watchlist: [],
      results: [],
      factors: { decisions: [{ intervention: "Pregnenolone", purpose: "sleep" }] },
      finding: {
        disease: [{ group: "Cardiovascular Risk", finding: "x" }],
        decisions: { patient: [], ai: [] },
        doctorConversation: [
          { group: "Cardiovascular Risk", questions: ["ask about ApoB"] },
          { group: "Rosuvastatin", questions: ["ask about dose"] },
        ],
      },
    } as unknown as Client;
  }

  const answer = {
    patient: [
      {
        intervention: "Pregnenolone",
        purpose: "sleep",
        pros: ["a"],
        cons: ["b"],
        alternatives: ["c"],
        recommendation: "consider",
        questions: ["Ask whether pregnenolone interacts with my current stack."],
      },
    ],
  };

  it("splices the patient group between the disease groups and the AI groups", () => {
    const merged = mergeLeafResult(coreClient(), "hypothesisEvaluation", answer);
    expect(merged.finding!.doctorConversation.map((g) => g.group)).toEqual([
      "Cardiovascular Risk",
      "Pregnenolone",
      "Rosuvastatin",
    ]);
    expect(merged.finding!.doctorConversation[1].questions).toEqual([
      "Ask whether pregnenolone interacts with my current stack.",
    ]);
  });

  it("keeps questions off the stored decision entry — that shape is FindingDecisionEntry", () => {
    const merged = mergeLeafResult(coreClient(), "hypothesisEvaluation", answer);
    expect(merged.finding!.decisions!.patient[0] as object).not.toHaveProperty("questions");
  });

  it("rejects an entry with no questions rather than silently leaving the band empty", () => {
    const spec = LEAF_REGEN_SPECS.hypothesisEvaluation;
    const { questions: _q, ...noQuestions } = answer.patient[0];
    expect(() => spec.validate({ patient: [noQuestions] })).toThrow(/questions/);
  });
});

// W67 — the guard that makes the group rule stick. Every leaf whose tool schema declares a `group`
// property is claiming its rows carry a body-system tag, and every one of those prompts says the tag
// MUST name a real disease group. Before this, two of six actually checked. Adding a seventh such
// node without the check now fails here rather than silently filing rows under a bucket the
// clinician never chose (system-groups.ts sweeps unknown tags into "Not yet categorized").
describe("every group-tagging leaf checks its tags", () => {
  const tagging = Object.entries(LEAF_REGEN_SPECS).filter(([, spec]) => {
    const schema = spec.toolSchema as {
      input_schema?: { properties?: Record<string, { items?: { properties?: Record<string, unknown> } }> };
    };
    return Object.values(schema.input_schema?.properties ?? {}).some((p) => p.items?.properties?.group);
  });

  it("finds the group-tagging leaves at all (so the filter above can't silently match nothing)", () => {
    expect(tagging.map(([node]) => node).sort()).toEqual([
      "allergyResults",
      "diseaseResults",
      "familyResults",
      "noteResults",
      "studyResults",
      "treatmentAssessment",
    ]);
  });

  it.each(tagging.map(([node]) => node))("%s calls assertDiseaseGroups in its merge", (node) => {
    expect(LEAF_REGEN_SPECS[node].mergeInto.toString()).toContain("assertDiseaseGroups");
  });

  it.each(tagging.map(([node]) => node))("%s rejects a group the Finding does not have", (node) => {
    const spec = LEAF_REGEN_SPECS[node];
    const idField = { noteResults: "noteId", allergyResults: "allergyId", familyResults: "familyId", diseaseResults: "diseaseId" }[node];
    const row = idField
      ? { [idField]: "row-1", result: "r", group: "Invented System" }
      : node === "studyResults"
        ? { study: "S", result: "r", group: "Invented System" }
        : { item: "Rosuvastatin", assessment: "a", group: "Invented System" };
    expect(() => spec.mergeInto(base(), { items: [row] })).toThrow(/Invented System/);
  });
});

// W67 — hypothesisEvaluation owns decisions.patient, so finding-assemble.ts:298-320's body rules no
// longer run on it: the core path never sees this section. An entry with zero pros or an empty
// recommendation used to merge fine and render as a blank column under a heading promising content.
describe("hypothesisEvaluation: the entry must have a body, and be about something that was asked", () => {
  const spec = LEAF_REGEN_SPECS.hypothesisEvaluation;
  const entry = (over: Record<string, unknown> = {}) => ({
    intervention: "Pregnenolone",
    purpose: "sleep",
    pros: ["p1", "p2"],
    cons: ["c1", "c2"],
    alternatives: ["a1", "a2"],
    recommendation: "Discuss with the prescribing physician.",
    questions: ["ask about it"],
    ...over,
  });

  it("accepts a complete entry", () => {
    expect(() => spec.validate({ patient: [entry()] })).not.toThrow();
  });

  it.each(["pros", "cons", "alternatives"])("rejects %s with fewer than 2 bullets", (field) => {
    expect(() => spec.validate({ patient: [entry({ [field]: ["only one"] })] })).toThrow(/2\+ bullets/);
  });

  it.each(["pros", "cons", "alternatives"])("rejects a blank bullet in %s", (field) => {
    expect(() => spec.validate({ patient: [entry({ [field]: ["real", "   "] })] })).toThrow(/is empty/);
  });

  it("rejects an empty recommendation", () => {
    expect(() => spec.validate({ patient: [entry({ recommendation: "  " })] })).toThrow(/recommendation is empty/);
  });

  it("rejects an idea the patient never raised", () => {
    const context = { patientHypothesis: [{ intervention: "Pregnenolone", purpose: "sleep" }] };
    expect(() => spec.checkAgainstInput!(context, { patient: [entry({ intervention: "Freediving" })] })).toThrow(
      /"Freediving" is not one of the 1 ideas/,
    );
    expect(() => spec.checkAgainstInput!(context, { patient: [entry()] })).not.toThrow();
  });

  // W75 — membership was the only rule this node made. aiOnPlan has made all three since W67.
  it("rejects an idea left unevaluated, and one evaluated twice", () => {
    const context = {
      patientHypothesis: [{ intervention: "Pregnenolone", purpose: "sleep" }, { intervention: "Creatine", purpose: "strength" }],
    };
    expect(() => spec.checkAgainstInput!(context, { patient: [entry()] })).toThrow(/1 of 2 ideas went unanswered/);
    expect(() =>
      spec.checkAgainstInput!(context, { patient: [entry(), entry(), entry({ intervention: "Creatine" })] }),
    ).toThrow(/appears more than once/);
  });

  it("narrows coverage to a scoped request", () => {
    const context = {
      patientHypothesis: [{ intervention: "Pregnenolone", purpose: "sleep" }, { intervention: "Creatine", purpose: "strength" }],
    };
    expect(() => spec.checkAgainstInput!(context, { patient: [entry()] }, ["Pregnenolone"])).not.toThrow();
  });

  // The subjectOf case: this node keys by a CONTENT label, so a re-answer whose label drifted used to
  // append a second entry and leave the stale one FIRST — and every reader takes the first match, so
  // re-translating could never correct a wrong evaluation, only accumulate copies.
  it("supersedes a prior entry whose label drifted rather than accumulating both", () => {
    const c = {
      displayName: "P",
      watchlist: [],
      results: [],
      factors: { decisions: [{ intervention: "Pregnenolone 50mg", purpose: "sleep" }] },
      finding: {
        disease: [{ group: "Cardiovascular Risk", finding: "x" }],
        decisions: { ai: [], patient: [{ ...entry({ intervention: "Pregnenolone 50 mg", recommendation: "STALE" }), questions: undefined }] },
        doctorConversation: [{ group: "Cardiovascular Risk", questions: ["q"] }],
      },
    } as unknown as Client;
    const merged = spec.mergeInto(c, { patient: [entry({ intervention: "Pregnenolone 50mg/day", recommendation: "FRESH" })] });
    expect(merged.finding!.decisions!.patient).toHaveLength(1);
    expect(merged.finding!.decisions!.patient[0].recommendation).toBe("FRESH");
  });
});

// W75 — `typeof x === "string"` accepted "", and an empty result rendered as a blank AI paragraph
// under its heading: indistinguishable, to the patient, from "there is nothing to say about this".
describe("row leaves reject a present-but-empty answer", () => {
  const row = (over: Record<string, unknown> = {}) => ({ noteId: "n1", result: "r", group: "Cardiovascular Risk", ...over });

  it.each(["noteId", "result", "group"])("rejects an empty %s on noteResults", (field) => {
    expect(() => LEAF_REGEN_SPECS.noteResults.validate({ items: [row({ [field]: "   " })] })).toThrow(/empty/);
  });

  it("rejects an empty result on studyResults and aiOnPlan too", () => {
    expect(() =>
      LEAF_REGEN_SPECS.studyResults.validate({ items: [{ study: "S", result: "", group: "Cardiovascular Risk" }] }),
    ).toThrow(/empty/);
    expect(() => LEAF_REGEN_SPECS.aiOnPlan.validate({ rows: [{ action: "A", assessment: "  " }] })).toThrow(/empty/);
  });

  it("still accepts a real answer", () => {
    expect(() => LEAF_REGEN_SPECS.noteResults.validate({ items: [row()] })).not.toThrow();
  });
});
