import {
  NOTE_RESULTS_TOOL,
  NOTE_RESULTS_SYSTEM_PROMPT,
  ALLERGY_RESULTS_TOOL,
  ALLERGY_RESULTS_SYSTEM_PROMPT,
  FAMILY_RESULTS_TOOL,
  FAMILY_RESULTS_SYSTEM_PROMPT,
  DISEASE_RESULTS_TOOL,
  DISEASE_RESULTS_SYSTEM_PROMPT,
} from "../leaf-regen-prompts";
import { assertDiseaseGroups, assertIdSetMatches, filterRowsById, mergeLabeledItems, validateIdRows, type IdRowResult } from "../leaf-regen-rows";
import type { LeafRegenSpec } from "./spec";

// The four leaves answering patient-entered rows, paired by echoed row id: position pairing could not notice a skipped row.
// An existing entry keeps its group tag and takes only the fresh result.

export const noteResults: LeafRegenSpec = {
  node: "noteResults",
  ownedSections: ["noteResults"],
  toolSchema: NOTE_RESULTS_TOOL,
  systemPromptExtra: NOTE_RESULTS_SYSTEM_PROMPT,
  buildContext: filterRowsById("noteResults", "pursuedNotes"),
  isEmpty: (context) => (context.pursuedNotes as unknown[]).length === 0,
  validate: validateIdRows("noteId"),
  checkAgainstInput: (context, result) =>
    assertIdSetMatches("noteResults", context, "pursuedNotes", "noteId", (result as { items: IdRowResult[] }).items),
  mergeInto: (client, result) => {
    const { items } = result as { items: IdRowResult[] };
    assertDiseaseGroups(client, "noteResults", items);
    const noteResults = mergeLabeledItems(
      client.finding?.noteResults ?? [],
      items.map((i) => ({ noteId: i.noteId, result: i.result, group: i.group })),
      (n) => n.noteId,
      (item, existing) => (existing ? { ...existing, result: item.result } : item),
    );
    return { ...client, finding: { ...client.finding!, noteResults } };
  },
};

export const allergyResults: LeafRegenSpec = {
  node: "allergyResults",
  ownedSections: ["allergyResults"],
  toolSchema: ALLERGY_RESULTS_TOOL,
  systemPromptExtra: ALLERGY_RESULTS_SYSTEM_PROMPT,
  buildContext: filterRowsById("allergyResults", "patientAllergies"),
  isEmpty: (context) => (context.patientAllergies as unknown[]).length === 0,
  validate: validateIdRows("allergyId"),
  checkAgainstInput: (context, result) =>
    assertIdSetMatches("allergyResults", context, "patientAllergies", "allergyId", (result as { items: IdRowResult[] }).items),
  mergeInto: (client, result) => {
    const { items } = result as { items: IdRowResult[] };
    assertDiseaseGroups(client, "allergyResults", items);
    const allergyResults = mergeLabeledItems(
      client.finding?.allergyResults ?? [],
      items.map((i) => ({ allergyId: i.allergyId, result: i.result, group: i.group })),
      (a) => a.allergyId,
      (item, existing) => (existing ? { ...existing, result: item.result } : item),
    );
    return { ...client, finding: { ...client.finding!, allergyResults } };
  },
};

export const familyResults: LeafRegenSpec = {
  node: "familyResults",
  ownedSections: ["familyResults"],
  toolSchema: FAMILY_RESULTS_TOOL,
  systemPromptExtra: FAMILY_RESULTS_SYSTEM_PROMPT,
  buildContext: filterRowsById("familyResults", "patientFamilyHistory"),
  isEmpty: (context) => (context.patientFamilyHistory as unknown[]).length === 0,
  validate: validateIdRows("familyId"),
  checkAgainstInput: (context, result) =>
    assertIdSetMatches("familyResults", context, "patientFamilyHistory", "familyId", (result as { items: IdRowResult[] }).items),
  mergeInto: (client, result) => {
    const { items } = result as { items: IdRowResult[] };
    assertDiseaseGroups(client, "familyResults", items);
    const familyResults = mergeLabeledItems(
      client.finding?.familyResults ?? [],
      items.map((i) => ({ familyId: i.familyId, result: i.result, group: i.group })),
      (f) => f.familyId,
      (item, existing) => (existing ? { ...existing, result: item.result } : item),
    );
    return { ...client, finding: { ...client.finding!, familyResults } };
  },
};

export const diseaseResults: LeafRegenSpec = {
  node: "diseaseResults",
  ownedSections: ["diseaseResults"],
  toolSchema: DISEASE_RESULTS_TOOL,
  systemPromptExtra: DISEASE_RESULTS_SYSTEM_PROMPT,
  buildContext: filterRowsById("diseaseResults", "diagnosedDisease"),
  isEmpty: (context) => (context.diagnosedDisease as unknown[]).length === 0,
  validate: validateIdRows("diseaseId"),
  checkAgainstInput: (context, result) =>
    assertIdSetMatches("diseaseResults", context, "diagnosedDisease", "diseaseId", (result as { items: IdRowResult[] }).items),
  mergeInto: (client, result) => {
    const { items } = result as { items: IdRowResult[] };
    assertDiseaseGroups(client, "diseaseResults", items);
    const diseaseResults = mergeLabeledItems(
      client.finding?.diseaseResults ?? [],
      items.map((i) => ({ diseaseId: i.diseaseId, result: i.result, group: i.group })),
      (d) => d.diseaseId,
      (item, existing) => (existing ? { ...existing, result: item.result } : item),
    );
    return { ...client, finding: { ...client.finding!, diseaseResults } };
  },
};
