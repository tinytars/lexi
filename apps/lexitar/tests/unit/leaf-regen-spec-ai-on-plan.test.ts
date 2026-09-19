import { describe, it, expect } from "vitest";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import { client } from "../fixtures/leaf-regen-client";

const planSpec = LEAF_REGEN_SPECS.aiOnPlan;

describe("leaf-regen-specs: aiOnPlan", () => {
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
