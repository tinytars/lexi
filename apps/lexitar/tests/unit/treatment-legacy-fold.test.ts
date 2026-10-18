import { describe, it, expect } from "vitest";
import { foldLegacyTreatments, dropLegacyTreatmentFields, treatmentEditDraft } from "../../src/lib/treatment-legacy-fold";
import type { Client, LegacyFactors } from "../../src/lib/types";

function legacyClient(): Client {
  return {
    displayName: "P",
    factors: { medications: [{ drug: "Metformin", dose: "500mg", since: "2024-03" }], supplements: [{ drug: "D3" }] } as LegacyFactors,
  } as Client;
}

describe("foldLegacyTreatments", () => {
  it("folds legacy medications/supplements into treatments, keeping the legacy fields", () => {
    const c = foldLegacyTreatments(legacyClient());
    expect(c.factors!.treatments!.map((t) => [t.name, t.kind])).toEqual([["Metformin", "drug"], ["D3", "supplement"]]);
    expect((c.factors as LegacyFactors).medications).toHaveLength(1);
  });

  it("leaves an existing treatments array untouched", () => {
    const treatments = [{ id: "a", name: "Aspirin", start: "2024-01-01" }];
    const c = foldLegacyTreatments({ displayName: "P", factors: { treatments } } as Client);
    expect(c.factors!.treatments).toBe(treatments);
  });

  it("creates factors when absent", () => {
    expect(foldLegacyTreatments({ displayName: "P" } as Client).factors!.treatments).toEqual([]);
  });
});

describe("dropLegacyTreatmentFields", () => {
  it("removes medications, supplements and plan", () => {
    const c = legacyClient();
    (c.factors as LegacyFactors).plan = [{ action: "walk" }];
    expect(dropLegacyTreatmentFields(c).factors).toEqual({});
  });

  it("tolerates a client without factors", () => {
    expect(dropLegacyTreatmentFields({ displayName: "P" } as Client).factors).toBeUndefined();
  });
});

describe("treatmentEditDraft", () => {
  it("folds, coerces month-only dates to month end, and drops legacy fields", () => {
    const c = treatmentEditDraft(legacyClient());
    expect(c.factors!.treatments![0].start).toBe("2024-03-31");
    expect(Object.keys(c.factors!)).toEqual(["treatments"]);
  });

  it("coerces end as well as start, and leaves full dates alone", () => {
    const treatments = [{ id: "a", name: "A", start: "2024-02-10", end: "2024-02" }];
    const c = treatmentEditDraft({ displayName: "P", factors: { treatments } } as Client);
    expect(c.factors!.treatments![0]).toMatchObject({ start: "2024-02-10", end: "2024-02-29" });
  });
});
