import { describe, it, expect } from "vitest";
import { backfillDose } from "../../scripts/dose-backfill";
import type { Vault } from "../../src/lib/types";

function vaultWithTreatments(treatments: Record<string, unknown>[]): Vault {
  return {
    clients: {
      Test: {
        displayName: "Test",
        dob: "1980-01-01",
        gender: "male",
        watchlist: [],
        results: [],
        factors: { treatments: treatments as any },
      } as any,
    },
  };
}

describe("backfillDose", () => {
  it("converts a clean 'amount unit/frequency' string and clears the legacy dose", () => {
    const vault = vaultWithTreatments([{ id: "1", name: "Rosuvastatin", start: "2024-01", dose: "6mg/week" }]);

    const { migrated, needsReview } = backfillDose(vault);

    expect(migrated).toBe(1);
    expect(needsReview).toEqual([]);
    const t = vault.clients.Test.factors!.treatments![0] as any;
    expect(t.doseAmount).toBe(6);
    expect(t.doseUnit).toBe("mg");
    expect(t.doseFrequency).toBe("week");
    expect(t.dose).toBeUndefined();
  });

  it("converts a bare number with no unit or frequency", () => {
    const vault = vaultWithTreatments([{ id: "1", name: "Vitamin D", start: "2024-01", dose: "1.0" }]);

    const { migrated } = backfillDose(vault);

    expect(migrated).toBe(1);
    const t = vault.clients.Test.factors!.treatments![0] as any;
    expect(t.doseAmount).toBe(1);
    expect(t.doseUnit).toBeUndefined();
    expect(t.doseFrequency).toBeUndefined();
  });

  it("accepts a space between amount and unit, and a frequency alias like 'day'/'daily'", () => {
    const vault = vaultWithTreatments([
      { id: "1", name: "A", start: "2024-01", dose: "10 mg" },
      { id: "2", name: "B", start: "2024-01", dose: "5mg/daily" },
    ]);

    backfillDose(vault);

    const [a, b] = vault.clients.Test.factors!.treatments! as any[];
    expect(a.doseAmount).toBe(10);
    expect(a.doseUnit).toBe("mg");
    expect(b.doseFrequency).toBe("day");
  });

  it("leaves a string with a trailing qualifier untouched and reports it for manual review", () => {
    const vault = vaultWithTreatments([{ id: "1", name: "Magnesium Glycinate", start: "2024-01", dose: "1.5g/day elemental" }]);

    const { migrated, needsReview } = backfillDose(vault);

    expect(migrated).toBe(0);
    expect(needsReview).toEqual(['Test / Magnesium Glycinate: "1.5g/day elemental"']);
    const t = vault.clients.Test.factors!.treatments![0] as any;
    expect(t.dose).toBe("1.5g/day elemental");
    expect(t.doseAmount).toBeUndefined();
  });

  it("skips a treatment with no dose at all (a behavior)", () => {
    const vault = vaultWithTreatments([{ id: "1", name: "10k steps/day", start: "2024-01" }]);

    const { migrated, needsReview } = backfillDose(vault);

    expect(migrated).toBe(0);
    expect(needsReview).toEqual([]);
  });

  it("is idempotent: skips a treatment already migrated (doseAmount set)", () => {
    const vault = vaultWithTreatments([{ id: "1", name: "A", start: "2024-01", doseAmount: 6, doseUnit: "mg" }]);

    const { migrated, needsReview } = backfillDose(vault);

    expect(migrated).toBe(0);
    expect(needsReview).toEqual([]);
  });
});
