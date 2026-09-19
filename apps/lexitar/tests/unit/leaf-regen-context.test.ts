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
    const context = buildLeafContext("treatmentAssessment", c);
    const history = context.treatmentHistory as { id: string; dailyTotal?: unknown }[];
    const am = history.find((t) => t.id === "m1");
    const pm = history.find((t) => t.id === "m2");
    expect(am?.dailyTotal).toEqual([{ name: "Magnesium", amountPerDay: 240, unit: "mg", form: "as magnesium glycinate" }]);
    expect(pm?.dailyTotal).toEqual(am?.dailyTotal);
  });
});
