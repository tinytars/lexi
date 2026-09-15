import type { Client } from "../../src/lib/types";
import { addTreatment, addDisease, addDecision } from "../../scripts/factors";

// Shared client variants for the canonical-golden guard (see canonical-golden.test.ts). Defined once
// here — not duplicated between the test and whatever regenerates the golden fixture — so the two
// paths can never silently drift apart, which would defeat the guard's purpose.

function bare(): Client {
  return { displayName: "Bare", dob: "1980-01-01", gender: "male", watchlist: [], results: [], factors: {} };
}

// Every branch that emits `undefined`-and-gets-dropped (allergies, familyHistory, noteEntries) rather
// than `[]` when empty — exactly where a stableStringify rewrite is most likely to silently drift.
function fullyPopulated(): Client {
  return {
    displayName: "Full",
    dob: "1975-06-15",
    gender: "female",
    watchlist: ["ApoB", "LDL"],
    results: [
      { marker: "ApoB", group: "Lipids", source: "lab", date: "2026-01-01", value: 80, unit: "mg/dL" },
      { marker: "LDL", group: "Lipids", source: "lab", date: "2026-01-01", value: 120, unit: "mg/dL" },
    ],
    factors: {
      diseases: [{ id: "d1", date: "2025", diagnostic: "CAC 100", summary: "Moderate calcification" }],
      treatments: [
        { id: "t1", name: "Ezetimibe", dose: "10 mg", kind: "drug", start: "2025-01" }, // ongoing
        { id: "t2", name: "Statin", kind: "drug", start: "2024-01", end: "2024-12" }, // past
        { id: "t3", name: "Start rosuvastatin", kind: "drug", start: "2099-02" }, // planned
      ],
      allergies: [{ id: "a1", pinned: true, allergen: "Penicillin", reaction: "Hives", severity: "moderate", dateNoted: "2020-01-01" }],
      familyHistory: [{ id: "f1", relation: "Father", condition: "MI at 55" }],
      decisions: [{ id: "d1", intervention: "TRT", purpose: "free T" }],
      noteEntries: [
        { id: "n1", text: "Ask about statin intolerance" },
        { id: "n2", pinned: true, text: "" }, // blank text — noteCanonical filters this out
      ],
      pregnancy: "none",
      athletic: "moderate",
      bmi: 24.5,
      height: "5'10\"",
      smoking: "never",
      ethnicity: "Hispanic",
      goal: "lower ApoB",
      focus: "cardiovascular",
    },
    study: { entries: [{ id: "study-1", focus: "Suspicion", detail: "CVD" }] },
  };
}

function emptyFactors(): Client {
  return { displayName: "Empty", dob: "1990-03-20", gender: "male", watchlist: [], results: [] };
}

// Mirrors hash-consistency.test.ts's regression guard: data authored through the CLI verbs
// (scripts/factors.ts), which is how a Finding's nodeHashes actually get stamped in production.
function cliAuthored(): Client {
  const c: Client = { displayName: "CLI", dob: "1982-11-02", gender: "female", watchlist: ["ApoB"], results: [], factors: {} };
  addTreatment(c, { name: "Enclomiphene", dose: "12.5mg", kind: "drug", start: "2026-01" });
  addTreatment(c, { name: "Tirzepatide", dose: "6mg/week", kind: "drug", start: "2025-08", end: "2025-12" });
  addDisease(c, { date: "2024-01", diagnostic: "Hyperlipidemia" });
  addDecision(c, { intervention: "TRT", purpose: "improved free T" });
  return c;
}

export const CANONICAL_VARIANTS: Record<string, () => Client> = {
  bare,
  fullyPopulated,
  emptyFactors,
  cliAuthored,
};
