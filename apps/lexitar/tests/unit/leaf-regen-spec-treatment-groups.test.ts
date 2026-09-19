import { describe, it, expect } from "vitest";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import type { RegroupInputs, RegroupResponse } from "@pablotech/akesi/finding-regroup";
import { client } from "../fixtures/leaf-regen-client";

function validResp(): RegroupResponse {
  return {
    groups: [
      { system: "S1", topic: "Lipid-lowering", patient: ["A1"], ai: ["AI1", "AI2"] },
      { system: "S2", topic: "Methyl donors", patient: ["P1"], ai: [] },
    ],
  };
}

const spec = LEAF_REGEN_SPECS.treatmentGroups;

describe("leaf-regen-specs: treatmentGroups", () => {
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
