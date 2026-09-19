import { describe, it, expect } from "vitest";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import { client, hyp } from "../fixtures/leaf-regen-client";

const hypSpec = LEAF_REGEN_SPECS.hypothesisEvaluation;

describe("leaf-regen-specs: hypothesisEvaluation", () => {
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
