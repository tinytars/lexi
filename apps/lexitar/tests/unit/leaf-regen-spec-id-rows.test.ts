import { describe, it, expect } from "vitest";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import type { Client } from "../../src/lib/types";
import { client, clientWithNotes, clientWithDiseases, clientWithAllergies, clientWithFamilyHistory } from "../fixtures/leaf-regen-client";

const nrSpec = LEAF_REGEN_SPECS.noteResults;
const dsSpec = LEAF_REGEN_SPECS.diseaseResults;

describe("leaf-regen-specs: noteResults", () => {
  it("registers a spec with its own tool schema; no scopedArrayKey (row-scoping uses buildContext filtering, not the content-based SCOPE OVERRIDE mechanism)", () => {
    expect(nrSpec).toBeDefined();
    expect((nrSpec.toolSchema as { name: string }).name).toBe("emit_note_results");
    expect(nrSpec.scopedArrayKey).toBeUndefined();
  });

  // M-translate — a row-level Translate click passes targetIds so the model only ever sees the one
  // note; without targetIds, buildContext is unscoped (every populated note), same as before.
  it("buildContext without targetIds returns every populated note", () => {
    const c = clientWithNotes();
    const context = nrSpec.buildContext!(c);
    expect(context.pursuedNotes).toEqual([{ id: "note-1", text: "Woke up with tingling in my left hand." }]);
  });

  it("buildContext with targetIds filters pursuedNotes down to just those ids", () => {
    const c = clientWithNotes();
    const withSecondNote: Client = {
      ...c,
      factors: {
        ...c.factors,
        noteEntries: [
          { id: "note-1", text: "Woke up with tingling in my left hand." },
          { id: "note-2", text: "Second note." },
        ],
      },
    } as unknown as Client;
    const context = nrSpec.buildContext!(withSecondNote, ["note-2"]);
    expect(context.pursuedNotes).toEqual([{ id: "note-2", text: "Second note." }]);
  });

  it("isEmpty is true only when there are no populated notes", () => {
    expect(nrSpec.isEmpty!({ pursuedNotes: [] })).toBe(true);
    expect(nrSpec.isEmpty!({ pursuedNotes: [{ id: "note-1", text: "some note" }] })).toBe(false);
  });

  it("validate requires the echoed noteId alongside result and group", () => {
    const good = { items: [{ noteId: "note-1", result: "Nothing here connects to a lab finding.", group: "Cardiovascular Risk" }] };
    expect(nrSpec.validate(good)).toEqual(good);
    expect(() => nrSpec.validate({})).toThrow(/items missing/);
    expect(() => nrSpec.validate({ items: [{ result: "x" }] })).toThrow(/noteId, result, group/);
    // The id is what pairs the answer to its note; without it the answer was silently position-paired.
    expect(() => nrSpec.validate({ items: [{ result: "x", group: "Cardiovascular Risk" }] })).toThrow(/noteId, result, group/);
  });

  it("mergeInto pairs the returned item to its note by the ECHOED id and updates only that entry's result", () => {
    const c = clientWithNotes();
    const result = { items: [{ noteId: "note-1", result: "Refreshed read.", group: "Cardiovascular Risk" }] };
    const updated = nrSpec.mergeInto(c, result);
    expect(updated.finding!.noteResults).toEqual([{ noteId: "note-1", result: "Refreshed read.", group: "Cardiovascular Risk" }]);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.noteResults![0].result).toBe("old note result");
  });

  it("mergeInto appends a new entry for a note with no prior finding.noteResults row (e.g. a Note added since the last full regen)", () => {
    const c = client();
    const withSecondNote: Client = {
      ...c,
      factors: {
        ...c.factors,
        noteEntries: [
          { id: "note-1", text: "Woke up with tingling in my left hand." },
          { id: "note-2", text: "New note since the last regen." },
        ],
      },
    } as unknown as Client;
    // Deliberately returned in REVERSE order: the ids decide where each answer lands, so a response
    // the model happens to order differently must still be correct. Under position pairing this
    // exact payload filed each answer against the wrong note.
    const result = {
      items: [
        { noteId: "note-2", result: "Newly generated read.", group: "Cardiovascular Risk" },
        { noteId: "note-1", result: "old note result", group: "Cardiovascular Risk" },
      ],
    };
    const updated = nrSpec.mergeInto(withSecondNote, result);
    expect(updated.finding!.noteResults).toEqual([
      { noteId: "note-1", result: "old note result", group: "Cardiovascular Risk" },
      { noteId: "note-2", result: "Newly generated read.", group: "Cardiovascular Risk" },
    ]);
  });

  // M-translate — a scoped response is length-1 regardless of which note it's for. It carries its own
  // noteId now, so it lands correctly without the merge being told which row was targeted; a Translate
  // click on note-2 can no longer overwrite note-1.
  it("a scoped one-item response lands on its own note, with no targetIds passed to the merge", () => {
    const c = clientWithNotes();
    const withSecondNote: Client = {
      ...c,
      factors: {
        ...c.factors,
        noteEntries: [
          { id: "note-1", text: "Woke up with tingling in my left hand." },
          { id: "note-2", text: "Second note." },
        ],
      },
    } as unknown as Client;
    const result = { items: [{ noteId: "note-2", result: "Refreshed read for note-2 only.", group: "Cardiovascular Risk" }] };
    const updated = nrSpec.mergeInto(withSecondNote, result);
    expect(updated.finding!.noteResults).toEqual([
      { noteId: "note-1", result: "old note result", group: "Cardiovascular Risk" },
      { noteId: "note-2", result: "Refreshed read for note-2 only.", group: "Cardiovascular Risk" },
    ]);
  });
});

const arSpec = LEAF_REGEN_SPECS.allergyResults;
const frSpec = LEAF_REGEN_SPECS.familyResults;

describe("leaf-regen-specs: allergyResults", () => {
  it("registers a spec with its own tool schema; no scopedArrayKey (row-scoping uses buildContext filtering)", () => {
    expect(arSpec).toBeDefined();
    expect((arSpec.toolSchema as { name: string }).name).toBe("emit_allergy_results");
    expect(arSpec.scopedArrayKey).toBeUndefined();
  });

  it("buildContext with targetIds filters patientAllergies down to just those ids", () => {
    const c = clientWithAllergies();
    const withSecond: Client = {
      ...c,
      factors: { ...c.factors, allergies: [...c.factors!.allergies!, { id: "allergy-2", allergen: "Sulfa", reaction: "Rash" }] },
    } as unknown as Client;
    expect(arSpec.buildContext!(withSecond).patientAllergies).toEqual(withSecond.factors!.allergies);
    expect(arSpec.buildContext!(withSecond, ["allergy-2"]).patientAllergies).toEqual([{ id: "allergy-2", allergen: "Sulfa", reaction: "Rash" }]);
  });

  it("a scoped one-item response lands on its own allergy via the echoed id", () => {
    const c = clientWithAllergies();
    const withSecond: Client = {
      ...c,
      factors: { ...c.factors, allergies: [...c.factors!.allergies!, { id: "allergy-2", allergen: "Sulfa", reaction: "Rash" }] },
      finding: { ...c.finding!, allergyResults: [{ allergyId: "allergy-1", result: "old", group: "Cardiovascular Risk" }] },
    } as unknown as Client;
    const result = { items: [{ allergyId: "allergy-2", result: "Refreshed read for allergy-2 only.", group: "Cardiovascular Risk" }] };
    const updated = arSpec.mergeInto(withSecond, result);
    expect(updated.finding!.allergyResults).toEqual([
      { allergyId: "allergy-1", result: "old", group: "Cardiovascular Risk" },
      { allergyId: "allergy-2", result: "Refreshed read for allergy-2 only.", group: "Cardiovascular Risk" },
    ]);
  });
});

describe("leaf-regen-specs: familyResults", () => {
  it("registers a spec with its own tool schema; no scopedArrayKey (row-scoping uses buildContext filtering)", () => {
    expect(frSpec).toBeDefined();
    expect((frSpec.toolSchema as { name: string }).name).toBe("emit_family_results");
    expect(frSpec.scopedArrayKey).toBeUndefined();
  });

  it("buildContext with targetIds filters patientFamilyHistory down to just those ids", () => {
    const c = clientWithFamilyHistory();
    const withSecond: Client = {
      ...c,
      factors: { ...c.factors, familyHistory: [...c.factors!.familyHistory!, { id: "family-2", relation: "Father", condition: "Hypertension" }] },
    } as unknown as Client;
    expect(frSpec.buildContext!(withSecond).patientFamilyHistory).toEqual(withSecond.factors!.familyHistory);
    expect(frSpec.buildContext!(withSecond, ["family-2"]).patientFamilyHistory).toEqual([{ id: "family-2", relation: "Father", condition: "Hypertension" }]);
  });

  it("a scoped one-item response lands on its own family entry via the echoed id", () => {
    const c = clientWithFamilyHistory();
    const withSecond: Client = {
      ...c,
      factors: { ...c.factors, familyHistory: [...c.factors!.familyHistory!, { id: "family-2", relation: "Father", condition: "Hypertension" }] },
      finding: { ...c.finding!, familyResults: [{ familyId: "family-1", result: "old", group: "Cardiovascular Risk" }] },
    } as unknown as Client;
    const result = { items: [{ familyId: "family-2", result: "Refreshed read for family-2 only.", group: "Cardiovascular Risk" }] };
    const updated = frSpec.mergeInto(withSecond, result);
    expect(updated.finding!.familyResults).toEqual([
      { familyId: "family-1", result: "old", group: "Cardiovascular Risk" },
      { familyId: "family-2", result: "Refreshed read for family-2 only.", group: "Cardiovascular Risk" },
    ]);
  });
});

describe("leaf-regen-specs: diseaseResults", () => {
  it("registers a spec with its own tool schema and the shared row-scoping buildContext", () => {
    expect(dsSpec).toBeDefined();
    expect((dsSpec.toolSchema as { name: string }).name).toBe("emit_disease_results");
    // Without buildContext a row-scoped Translate on a diagnosis ran unscoped over every diagnosis.
    expect(dsSpec.buildContext).toBeDefined();
    expect(dsSpec.scopedArrayKey).toBeUndefined();
  });

  it("isEmpty is true only when there are no diagnoses on file", () => {
    expect(dsSpec.isEmpty!({ diagnosedDisease: [] })).toBe(true);
    expect(dsSpec.isEmpty!({ diagnosedDisease: [{ id: "dx-1", date: "2026-01-01", diagnostic: "Mild fatty liver" }] })).toBe(false);
  });

  it("validate requires the echoed diseaseId alongside result and group", () => {
    const good = { items: [{ diseaseId: "dx-1", result: "Consistent with existing lipid findings.", group: "Cardiovascular Risk" }] };
    expect(dsSpec.validate(good)).toEqual(good);
    expect(() => dsSpec.validate({})).toThrow(/items missing/);
    expect(() => dsSpec.validate({ items: [{ result: "x" }] })).toThrow(/diseaseId, result, group/);
  });

  it("mergeInto pairs the returned item to its diagnosis by the ECHOED id and updates only that entry's result", () => {
    const c = clientWithDiseases();
    const result = { items: [{ diseaseId: "dx-1", result: "Refreshed read.", group: "Cardiovascular Risk" }] };
    const updated = dsSpec.mergeInto(c, result);
    expect(updated.finding!.diseaseResults).toEqual([{ diseaseId: "dx-1", result: "Refreshed read.", group: "Cardiovascular Risk" }]);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.diseaseResults).toBeUndefined();
  });

  it("mergeInto appends a new entry for a diagnosis with no prior finding.diseaseResults row (e.g. a Report added since the last full regen)", () => {
    const c = clientWithDiseases();
    const withSecondDisease: Client = {
      ...c,
      factors: {
        ...c.factors,
        diseases: [
          { id: "dx-1", date: "2026-01-01", diagnostic: "Mild fatty liver" },
          { id: "dx-2", date: "2026-02-01", diagnostic: "New diagnosis since the last regen" },
        ],
      },
    } as unknown as Client;
    const result = {
      items: [
        { diseaseId: "dx-1", result: "Prior read.", group: "Cardiovascular Risk" },
        { diseaseId: "dx-2", result: "Newly generated read.", group: "Cardiovascular Risk" },
      ],
    };
    const updated = dsSpec.mergeInto(withSecondDisease, result);
    expect(updated.finding!.diseaseResults).toEqual([
      { diseaseId: "dx-1", result: "Prior read.", group: "Cardiovascular Risk" },
      { diseaseId: "dx-2", result: "Newly generated read.", group: "Cardiovascular Risk" },
    ]);
  });
});
