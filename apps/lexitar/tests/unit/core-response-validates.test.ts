import { describe, it, expect } from "vitest";
import { validateFindingResponse, validateFindingWithInputs } from "../../scripts/claude-finding";
import { coreOnlyResponse, decision } from "../fixtures/core-response";

// The core no longer writes leaf-owned sections, so validate() must not demand the cross-references they carried.
describe("validate accepts a core-only response", () => {
  it("does not require the sections the leaves now own", () => {
    expect(() => validateFindingResponse(coreOnlyResponse() as never)).not.toThrow();
  });

  // The specific rule that failed the live check: it must not demand placement into a section the
  // core does not write. When treatmentGroups IS present the rule still applies — next case.
  it("does not demand decisions.ai be placed in an absent treatmentGroups", () => {
    // doctorConversation must have exactly one entry per disease group + per decision, so the base
    // response's own AI entry is REPLACED, not added to.
    const r = coreOnlyResponse();
    r.decisions.ai = [decision("Rosuvastatin (titration confirmation)"), decision("Ezetimibe add-on")];
    r.doctorConversation = r.doctorConversation.filter((d) => d.group !== "Statin or PCSK9 inhibitor");
    r.doctorConversation.push(
      { group: "Rosuvastatin (titration confirmation)", questions: ["q"] },
      { group: "Ezetimibe add-on", questions: ["q"] },
    );
    expect(() => validateFindingResponse(r as never)).not.toThrow();
  });

  it("still demands placement when treatmentGroups IS present", () => {
    const r = coreOnlyResponse() as Record<string, unknown>;
    // Non-empty (a group with neither side is rejected earlier), but not placing the AI intervention.
    r.treatmentGroups = [{ system: "Cardiovascular Risk", topic: "Lipids", patient: ["Some patient item"], ai: [] }];
    expect(() => validateFindingResponse(r as never)).toThrow(/is not placed in any treatmentGroups group/);
  });
});

// The live refresh always supplies `expected` (the patient's hypotheses, plan actions and note ids);
// the structural-only wrapper above never does. Three rules fire ONLY under `expected`, and all
// three were unsatisfiable once the core stopped writing the section they cross-reference — which is
// why the tests above passed while a real run failed. These cover that gap.
describe("validate accepts a core-only response WITH expected inputs", () => {
  const expected = {
    patient: ["Try creatine", "Pregnenolone 25mg/day"],
    planActions: ["Pregnenolone 25mg/day", "Start Methylation stack (TBD)"],
    noteIds: ["n1", "n2"],
  };

  it("does not demand patient items be placed in an absent treatmentGroups", () => {
    expect(() => validateFindingWithInputs(coreOnlyResponse() as never, expected)).not.toThrow();
  });

  it("does not demand plan actions be assessed in an absent planAssessmentRows", () => {
    // Alex has five planned treatments, so this is the rule that would have failed the next run.
    expect(() => validateFindingWithInputs(coreOnlyResponse() as never, expected)).not.toThrow();
  });

  it("does not demand one noteResult per note when noteResults is absent", () => {
    expect(() => validateFindingWithInputs(coreOnlyResponse() as never, expected)).not.toThrow();
  });

  // The converse for each: when the core DOES carry the section, the cross-reference still binds.
  it("still enforces plan-action coverage when planAssessmentRows is present", () => {
    const r = coreOnlyResponse() as Record<string, unknown>;
    r.planAssessmentRows = [{ action: "Pregnenolone 25mg/day", assessment: "fine" }];
    expect(() => validateFindingWithInputs(r as never, expected)).toThrow(/is not assessed in planAssessmentRows/);
  });

  it("still enforces patient placement when treatmentGroups is present", () => {
    const r = coreOnlyResponse() as Record<string, unknown>;
    r.treatmentGroups = [{ system: "Cardiovascular Risk", topic: "Lipids", patient: ["Try creatine"], ai: ["Statin or PCSK9 inhibitor"] }];
    expect(() => validateFindingWithInputs(r as never, expected)).toThrow(/is not placed in any treatmentGroups group/);
  });
});
