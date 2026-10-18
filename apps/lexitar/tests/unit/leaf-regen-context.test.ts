import { describe, it, expect } from "vitest";
import { buildLeafContext } from "../../src/lib/leaf-regen-context";
import { client } from "../fixtures/leaf-regen-client";

describe("leaf-regen-context: buildLeafContext", () => {
  // dailyTotal is only ever an ADDITION to a row; the id-lookup and isEmpty checks depend on each row keeping its shape.
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
    const context = buildLeafContext("treatmentAssessment", c, "2026-09-19");
    const history = context.treatmentHistory as { id: string; dailyTotal?: unknown }[];
    const am = history.find((t) => t.id === "m1");
    const pm = history.find((t) => t.id === "m2");
    expect(am?.dailyTotal).toEqual([{ name: "Magnesium", amountPerDay: 240, unit: "mg", form: "as magnesium glycinate" }]);
    expect(pm?.dailyTotal).toEqual(am?.dailyTotal);
  });

  // One `today` drives the Today: line and the plan/history bucketing, so they cannot disagree across midnight.
  it("buckets patientPlan against the supplied today, and echoes it as the context's today", () => {
    const c = client();
    c.factors!.treatments!.push({ id: "t1", name: "Tirzepatide", kind: "drug", start: "2026-10-01" });
    const before = buildLeafContext("aiOnPlan", c, "2026-09-19");
    expect(before.today).toBe("2026-09-19");
    expect((before.patientPlan as { name: string }[]).map((t) => t.name)).toContain("Tirzepatide");
    const after = buildLeafContext("aiOnPlan", c, "2026-11-01");
    expect(after.today).toBe("2026-11-01");
    expect((after.patientPlan as { name: string }[]).map((t) => t.name)).not.toContain("Tirzepatide");
  });
});
