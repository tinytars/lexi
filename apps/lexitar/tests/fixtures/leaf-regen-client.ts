import type { Client } from "../../src/lib/types";

export function ai(intervention: string, purpose = "") {
  return { intervention, purpose, pros: [], cons: [], alternatives: [], recommendation: "" };
}

// The leaf returns questions alongside the evaluation, and must carry the same 2-8 bullet body the core path demands.
export function hyp(intervention: string, purpose = "a stated purpose") {
  return {
    intervention,
    purpose,
    pros: ["a benefit", "another benefit"],
    cons: ["a risk", "another risk"],
    alternatives: ["an alternative", "another alternative"],
    recommendation: "Discuss with the prescribing physician.",
    questions: ["ask about it"],
  };
}

export function client(): Client {
  return {
    displayName: "Alex",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: {
      decisions: [{ intervention: "Methylation stack", purpose: "overnight HRV" }],
      treatments: [{ name: "Start statin or statin-like approach", kind: "behavior", start: "2099-06" }],
    },
    study: { entries: [{ id: "study-1", focus: "Suspicion", detail: "possible statin intolerance" }] },
    finding: {
      disease: [
        { group: "Cardiovascular Risk", finding: "x" },
        { group: "Methylation / Nutrient Status", finding: "y" },
      ],
      decisions: {
        patient: [{ ...ai("Methylation stack", "overnight HRV"), recommendation: "old recommendation" }],
        ai: [ai("Rosuvastatin", "Cut ApoB"), ai("PCSK9 inhibitor", "Escalation")],
      },
      treatmentGroups: [{ system: "old", topic: "stale group", patient: [], ai: ["old ai item"] }],
      treatment: [{ item: "Ezetimibe 10 mg", assessment: "old assessment", group: "Cardiovascular Risk" }],
      studyResults: [{ study: "Suspicion", result: "old result", group: "Cardiovascular Risk" }],
      noteResults: [{ noteId: "note-1", result: "old note result", group: "Cardiovascular Risk" }],
    },
  } as unknown as Client;
}

// A second client with the noteEntries factors.noteEntries this suite's noteResults block reads from
// (client() above omits them entirely, matching every other fixture's minimal-factors style).
export function clientWithNotes(): Client {
  const c = client();
  return { ...c, factors: { ...c.factors, noteEntries: [{ id: "note-1", text: "Woke up with tingling in my left hand." }] } };
}

// Analogous fixture for diseaseResults, same minimal-factors style.
export function clientWithDiseases(): Client {
  const c = client();
  return { ...c, factors: { ...c.factors, diseases: [{ id: "dx-1", date: "2026-01-01", diagnostic: "Mild fatty liver" }] } };
}

// Analogous fixtures for allergyResults/familyResults, same minimal-factors style as clientWithNotes above.
export function clientWithAllergies(): Client {
  const c = client();
  return { ...c, factors: { ...c.factors, allergies: [{ id: "allergy-1", allergen: "Penicillin", reaction: "Hives" }] } };
}
export function clientWithFamilyHistory(): Client {
  const c = client();
  return { ...c, factors: { ...c.factors, familyHistory: [{ id: "family-1", relation: "Mother", condition: "Type 2 diabetes" }] } };
}
