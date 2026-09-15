import type { Client } from "./types";
import { canonicalFor } from "@pablotech/neuro";
import { findingDag } from "./finding-dag";
import { pinnedQueryLines } from "@pablotech/akesi/pinned-queries";
import { attachmentsCanonical, noteCanonical, studyCanonical, treatmentCanonical } from "./factors-hash";

// W15b — per-node staleness. One slice per DAG *input* node: the exact raw datum that node owns.
// Their union covers the same surface as findingInputsCanonicalString, partitioned by node, so a
// change to one datum touches only the nodes downstream of its owner.
// Split out of factors-hash.ts (M59) so that file — and anything that only needs
// factorsCanonicalString, like functions/api/refresh-range.ts — stays free of the finding-dag.ts
// import; only this DAG-input-closure hasher needs it.
export const INPUT_SLICES: Record<string, (c: Client) => unknown> = {
  labData: (c) => [...c.results].map((r) => `${r.marker}|${r.date}|${r.value}|${r.unit}`).sort(),
  watchlist: (c) => [...c.watchlist].sort(),
  patientAssessment: (c) => {
    const f = c.factors ?? {};
    return {
      dob: c.dob,
      gender: c.gender,
      pregnancy: f.pregnancy,
      athletic: f.athletic,
      bmi: f.bmi,
      height: f.height,
      smoking: f.smoking,
      ethnicity: f.ethnicity,
      allergies: f.allergies?.length ? f.allergies.map((a) => `${a.allergen}|${a.reaction}|${a.severity ?? ""}|${a.dateNoted ?? ""}`).sort() : undefined,
      familyHistory: f.familyHistory?.length ? f.familyHistory.map((h) => `${h.relation}|${h.condition}`).sort() : undefined,
    };
  },
  statedObjective: (c) => ({ goal: c.factors?.goal, focus: c.factors?.focus }),
  pursuedStudy: (c) => studyCanonical(c),
  pursuedNotes: (c) => noteCanonical(c),
  // M94 — dedicated slices for the new allergyResults/familyResults leaf nodes, additive to (not a
  // replacement for) the coarser allergies/familyHistory summaries already folded into
  // patientAssessment above (which still gate aiFindings/healthProgression/etc as before).
  // W75 — attachmentsCanonical on every slice whose rows can carry one (see its comment in
  // factors-hash.ts). `icdCodes` is the same class of miss: finding-generate.ts prints it into the
  // prompt twice and it hashed into nothing, so editing a diagnosis's codes left every downstream
  // answer reading fresh. Both append EMPTY when absent, so existing clients hash unchanged.
  patientAllergies: (c) => (c.factors?.allergies ?? []).map((a) => `${a.allergen}|${a.reaction}|${a.severity ?? ""}|${a.dateNoted ?? ""}${attachmentsCanonical(a.attachments)}`).sort(),
  patientFamilyHistory: (c) => (c.factors?.familyHistory ?? []).map((h) => `${h.relation}|${h.condition}${attachmentsCanonical(h.attachments)}`).sort(),
  diagnosedDisease: (c) =>
    (c.factors?.diseases ?? [])
      .map((d) => {
        const codes = d.icdCodes?.length ? `|icd:${[...d.icdCodes].sort().join(",")}` : "";
        return `${d.date}|${d.diagnostic}|${d.summary ?? ""}${codes}${attachmentsCanonical(d.attachments)}`;
      })
      .sort(),
  treatmentHistory: (c) => treatmentCanonical(c),
  patientHypothesis: (c) => (c.factors?.decisions ?? []).map((d) => `${d.intervention}|${d.purpose}${attachmentsCanonical(d.attachments)}`).sort(),
  patientPlan: (c) => treatmentCanonical(c),
  // W71 — the three sources that steered the prompt and hashed into nothing.
  //
  // Each returns `undefined` rather than an empty value when there is nothing to say, and that is
  // load-bearing: canonicalFor drops an undefined key, so a client who has never starred an item,
  // never picked a recommended marker and has no personalized range hashes BYTE-IDENTICALLY to
  // before these existed. Only clients who actually have this data move. Same guard and the same
  // reason as pinnedQueries/allergySummaries in factors-hash.ts.
  pinnedQueries: (c) => {
    const lines = pinnedQueryLines(c);
    return lines.length ? lines : undefined;
  },
  recommendedMarkers: (c) => {
    const list = [...(c.recommended ?? [])].sort();
    return list.length ? list : undefined;
  },
  personalizedRanges: (c) => {
    // Sorted entries, not the object: key order in a Record is insertion order, and two clients with
    // the same ranges added in a different order must hash the same.
    const entries = Object.entries(c.personalizedRanges ?? {})
      .map(([marker, r]) => `${marker}|${r.low ?? ""}|${r.high ?? ""}`)
      .sort();
    return entries.length ? entries : undefined;
  },
};

// Canonical string of the raw inputs a single DAG node depends on (its source closure). Shared by the
// Node CLI (nodeHashesOf, stamped at generation) and the browser (staleNodes) so both hash identically.
// W61 — the closure walk + stableStringify combination moved to @pablotech/neuro's canonicalFor();
// INPUT_SLICES (what gets normalized) stays here, since it's irreducibly clinical.
export function nodeInputCanonical(client: Client, nodeKey: string): string {
  return canonicalFor(findingDag, client, INPUT_SLICES, nodeKey);
}
