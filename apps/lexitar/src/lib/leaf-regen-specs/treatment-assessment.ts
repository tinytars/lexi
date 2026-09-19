import type { Bucket } from "@pablotech/akesi/treatment-bucket";
import { TREATMENT_ASSESSMENT_TOOL, TREATMENT_ASSESSMENT_SYSTEM_PROMPT } from "../leaf-regen-prompts";
import { assertDiseaseGroups, labelSubject, mergeLabeledItems } from "../leaf-regen-rows";
import type { LeafRegenSpec } from "./spec";

interface TreatmentAssessmentItem {
  treatmentId: string;
  item: string;
  assessment: string;
  group: string;
  phase?: Bucket;
}

type Keyable = { item: string; treatmentId?: string; phase?: Bucket };

// Patches finding.treatment[].assessment per (treatment, phase) and appends entries for treatments with none yet.
export const treatmentAssessment: LeafRegenSpec = {
  node: "treatmentAssessment",
  ownedSections: ["treatment"],
  toolSchema: TREATMENT_ASSESSMENT_TOOL,
  systemPromptExtra: TREATMENT_ASSESSMENT_SYSTEM_PROMPT,
  scopedArrayKey: "items",
  isEmpty: (context) => (context.treatmentHistory as unknown[]).length === 0,
  validate: (raw): { items: TreatmentAssessmentItem[] } => {
    const items = (raw as { items?: unknown })?.items;
    if (!Array.isArray(items)) throw new Error("items missing or not an array");
    for (const entry of items) {
      const e = entry as Partial<TreatmentAssessmentItem>;
      if (typeof e?.item !== "string" || typeof e?.assessment !== "string" || typeof e?.group !== "string") {
        throw new Error("item does not match { item, assessment, group } shape");
      }
      // The id is what pairs this prose with a drug; without it the merge would guess from a model-written name.
      if (typeof e?.treatmentId !== "string" || e.treatmentId.trim() === "") {
        throw new Error(`entry for "${e?.item ?? "?"}" is missing treatmentId`);
      }
    }
    return { items: items as TreatmentAssessmentItem[] };
  },
  // A hallucinated id would otherwise append an assessment of a drug the patient is not on.
  checkAgainstInput: (context, result) => {
    const known = new Set((context.treatmentHistory as { id: string }[]).map((t) => t.id));
    const unknown = (result as { items: TreatmentAssessmentItem[] }).items
      .map((i) => i.treatmentId)
      .filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`treatmentAssessment returned ${unknown.length} entr(ies) for unknown treatment id(s): ${[...new Set(unknown)].join(", ")}`);
    }
  },
  mergeInto: (client, result) => {
    const { items } = result as { items: TreatmentAssessmentItem[] };
    assertDiseaseGroups(client, "treatmentAssessment", items);
    // One-time migration: stamp id+phase onto legacy rows by label so they key-match instead of duplicating.
    // Phase must match only when the legacy row already has one — pre-id rows usually predate `phase` too.
    const existing = (client.finding?.treatment ?? []).map((row) => {
      if (row.treatmentId) return row;
      const phaseOk = (i: TreatmentAssessmentItem) => row.phase === undefined || i.phase === row.phase;
      const match = items.find(
        (i) => phaseOk(i) && i.item.toLowerCase().trim() === row.item.toLowerCase().trim(),
      ) ?? items.find((i) => phaseOk(i) && labelSubject(i.item) === labelSubject(row.item));
      return match ? { ...row, treatmentId: match.treatmentId, phase: match.phase } : row;
    });

    // Keyed by (drug, phase): one drug legitimately holds up to three entries.
    const keyed = <T extends Keyable>(t: T) => `${t.treatmentId ?? t.item.toLowerCase()}|${t.phase ?? ""}`;
    const subject = <T extends Keyable>(t: T) => `${t.treatmentId ?? labelSubject(t.item)}|${t.phase ?? ""}`;
    let treatment = mergeLabeledItems(
      existing,
      items,
      keyed,
      (item, existing) =>
        existing
          ? { ...existing, treatmentId: item.treatmentId, assessment: item.assessment, phase: item.phase }
          : { item: item.item, treatmentId: item.treatmentId, assessment: item.assessment, group: item.group, phase: item.phase },
      // Supersede by drug WITHIN a phase, never across, or a new past entry would evict the ongoing one.
      subject,
    );
    // Only a PHASED arrival retires a pre-phase entry; otherwise a phase-less answer would delete what it just merged.
    const phasedSubjects = new Set(items.filter((i) => i.phase).map((i) => labelSubject(i.item)));
    treatment = treatment.filter((t) => t.phase || !phasedSubjects.has(labelSubject(t.item)));
    return { ...client, finding: { ...client.finding!, treatment } };
  },
};
