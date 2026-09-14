import { describe, it, expect } from "vitest";
import { removeFrom } from "../../src/lib/vault-item-ops";
import { assembledFindingViolations } from "../../src/lib/finding-invariants";
import type { Client } from "../../src/lib/types";

// W68 — deleting a row used to leave the AI's turn about it in the Finding forever. No merge removes
// an entry (mergeLabeledItems deliberately keeps an existing one with no returned counterpart, so a
// scoped regen cannot wipe its siblings) and no caller pruned, so orphans only accumulated. Found by
// running finding-invariants.ts against the live vault: two assessments for treatments Alex had
// deleted, still on file.

function client(): Client {
  return {
    displayName: "P",
    watchlist: [],
    results: [],
    factors: {
      noteEntries: [
        { id: "n1", text: "kept" },
        { id: "n2", text: "doomed" },
      ],
      allergies: [{ id: "al1", allergen: "Pollen", reaction: "" }],
      familyHistory: [{ id: "fh1", relation: "Mother", condition: "T2D" }],
      decisions: [{ id: "d1", intervention: "Pregnenolone", purpose: "sleep" }],
      treatments: [
        { id: "t1", name: "Rosuvastatin", doseAmount: 10, doseUnit: "mg", doseFrequency: "day", start: "2024-01", end: "2025-01" },
        { id: "t2", name: "Rosuvastatin", doseAmount: 20, doseUnit: "mg", doseFrequency: "day", start: "2025-02" },
        { id: "t3", name: "Ezetimibe", start: "2025-03" },
      ],
    },
    study: { entries: [{ id: "s1", focus: "Statin intolerance", detail: "d" }] },
    finding: {
      disease: [{ group: "Cardiovascular Risk", finding: "x" }],
      noteResults: [
        { noteId: "n1", result: "about n1", group: "Cardiovascular Risk" },
        { noteId: "n2", result: "about n2", group: "Cardiovascular Risk" },
      ],
      allergyResults: [{ allergyId: "al1", result: "r", group: "Cardiovascular Risk" }],
      familyResults: [{ familyId: "fh1", result: "r", group: "Cardiovascular Risk" }],
      studyResults: [{ study: "Statin intolerance", result: "r", group: "Cardiovascular Risk" }],
      treatment: [
        { item: "Rosuvastatin 20mg/day", assessment: "a", group: "Cardiovascular Risk", phase: "ongoing" },
        { item: "Ezetimibe", assessment: "a", group: "Cardiovascular Risk", phase: "ongoing" },
      ],
      decisions: { ai: [], patient: [{ intervention: "Pregnenolone", purpose: "sleep", pros: ["p1", "p2"], cons: ["c1", "c2"], alternatives: ["a1", "a2"], recommendation: "r" }] },
      doctorConversation: [
        { group: "Cardiovascular Risk", questions: ["q"] },
        { group: "Pregnenolone", questions: ["q"] },
      ],
    },
  } as unknown as Client;
}

describe("deleting a row takes the AI's turn about it", () => {
  it("a note", () => {
    const out = removeFrom(client(), "note", "n2");
    expect(out.finding!.noteResults!.map((r) => r.noteId)).toEqual(["n1"]);
  });

  it("an allergy", () => {
    expect(removeFrom(client(), "allergy", "al1").finding!.allergyResults).toEqual([]);
  });

  it("a family history entry", () => {
    expect(removeFrom(client(), "family", "fh1").finding!.familyResults).toEqual([]);
  });

  it("a study entry, matched by its focus label", () => {
    expect(removeFrom(client(), "study", "s1").finding!.studyResults).toEqual([]);
  });

  it("an idea, along with its doctor-conversation group", () => {
    const out = removeFrom(client(), "decision", "d1");
    expect(out.finding!.decisions!.patient).toEqual([]);
    expect(out.finding!.doctorConversation.map((g) => g.group)).toEqual(["Cardiovascular Risk"]);
  });

  it("a treatment whose last dose period is gone", () => {
    const out = removeFrom(client(), "treatment", "t3");
    expect(out.finding!.treatment.map((e) => e.item)).toEqual(["Rosuvastatin 20mg/day"]);
  });

  // The case that makes the naive version wrong: a drug's dose history is several rows, and deleting
  // one must not take the assessment the remaining rows still need.
  it("but NOT when another dose period of the same drug remains", () => {
    const out = removeFrom(client(), "treatment", "t1"); // the discontinued 10mg row
    expect(out.factors!.treatments!.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(out.finding!.treatment.map((e) => e.item)).toContain("Rosuvastatin 20mg/day");
  });

  it("leaves the Finding with no orphans, which is what the invariant checks", () => {
    let c = client();
    for (const [kind, id] of [["note", "n2"], ["allergy", "al1"], ["family", "fh1"]] as const) {
      c = removeFrom(c, kind, id);
    }
    const orphans = assembledFindingViolations(c).filter((v) => /matches no row on file|no longer on file/.test(v));
    expect(orphans).toEqual([]);
  });

  it("is a no-op for kinds that do not offer Delete", () => {
    const c = client();
    expect(removeFrom(c, "marker", "x")).toBe(c);
    expect(removeFrom(c, "medicine", "t1")).toBe(c);
  });
});
