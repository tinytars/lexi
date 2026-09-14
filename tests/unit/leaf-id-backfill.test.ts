import { describe, it, expect } from "vitest";
import { backfillIds } from "../../scripts/leaf-id-backfill";
import type { Vault } from "../../src/lib/types";

function sampleVault(): Vault {
  return {
    clients: {
      Test: {
        displayName: "Test",
        dob: "1980-01-01",
        gender: "male",
        watchlist: [],
        results: [],
        factors: {
          diseases: [
            { date: "2024-01", diagnostic: "Hyperlipidemia" } as any,
            { id: "disease-1", date: "2024-02", diagnostic: "Hypertension" } as any,
          ],
          treatments: [
            { name: "Statin", start: "2024-01" } as any,
            { id: "treatment-1", name: "Metformin", start: "2024-02" } as any,
          ],
          allergies: [
            { allergen: "Penicillin", reaction: "Hives" } as any,
            { id: "allergy-1", allergen: "Latex", reaction: "Rash" } as any,
          ],
          familyHistory: [
            { relation: "Father", condition: "CAD" } as any,
            { id: "fh-1", relation: "Mother", condition: "T2D" } as any,
          ],
          decisions: [
            { intervention: "Start TRT", purpose: "Low T" } as any,
            { id: "decision-1", intervention: "Statin trial", purpose: "High LDL" } as any,
          ],
          noteEntries: [
            { text: "Prefers morning labs" } as any,
            { id: "note-1", text: "Vegetarian" } as any,
          ],
        },
        study: {
          entries: [
            { focus: "Selection", detail: "Considering endurance sports" } as any,
            { id: "study-1", focus: "Recovery", detail: "Sleep quality" } as any,
          ],
        },
      } as any,
    },
  };
}

describe("backfillIds", () => {
  it("mints ids for every row missing one across all 7 arrays, leaves existing ids untouched, and returns the count", () => {
    const vault = sampleVault();
    const n = backfillIds(vault);

    expect(n).toBe(7);

    const client = vault.clients.Test;
    const arrays = [
      client.factors!.diseases!,
      client.factors!.treatments!,
      client.factors!.allergies!,
      client.factors!.familyHistory!,
      client.factors!.decisions!,
      client.factors!.noteEntries!,
      client.study!.entries!,
    ];
    for (const arr of arrays) {
      for (const row of arr as { id?: string }[]) {
        expect(typeof row.id).toBe("string");
        expect(row.id!.length).toBeGreaterThan(0);
      }
    }

    // pre-existing ids are unchanged
    expect(client.factors!.diseases![1].id).toBe("disease-1");
    expect(client.factors!.treatments![1].id).toBe("treatment-1");
    expect(client.factors!.allergies![1].id).toBe("allergy-1");
    expect(client.factors!.familyHistory![1].id).toBe("fh-1");
    expect(client.factors!.decisions![1].id).toBe("decision-1");
    expect(client.factors!.noteEntries![1].id).toBe("note-1");
    expect(client.study!.entries![1].id).toBe("study-1");
  });

  it("is idempotent: a second call mints nothing and leaves ids unchanged", () => {
    const vault = sampleVault();
    backfillIds(vault);
    const client = vault.clients.Test;
    const before = client.factors!.diseases!.map((d) => d.id);

    const n = backfillIds(vault);

    expect(n).toBe(0);
    expect(client.factors!.diseases!.map((d) => d.id)).toEqual(before);
  });
});

