import type { TreatmentItem } from "../types";
import { treatmentLabel } from "@pablotech/akesi/treatment-bucket";
import { AI_ON_PLAN_TOOL, AI_ON_PLAN_SYSTEM_PROMPT } from "../leaf-regen-prompts";
import { labelSubject } from "../leaf-regen-rows";
import type { LeafRegenSpec } from "./spec";

type PlanRow = { action: string; assessment: string };

// Regenerates only finding.planAssessmentRows; the holistic planAssessment prose stays with the monolith.
export const aiOnPlan: LeafRegenSpec = {
  node: "aiOnPlan",
  ownedSections: ["planAssessmentRows"],
  toolSchema: AI_ON_PLAN_TOOL,
  systemPromptExtra: AI_ON_PLAN_SYSTEM_PROMPT,
  isEmpty: (context) => (context.patientPlan as unknown[]).length === 0,
  validate: (raw): { rows: PlanRow[] } => {
    const rows = (raw as { rows?: unknown })?.rows;
    if (!Array.isArray(rows)) throw new Error("rows missing or not an array");
    for (const entry of rows) {
      const e = entry as Partial<PlanRow>;
      if (typeof e?.action !== "string" || typeof e?.assessment !== "string") {
        throw new Error("row does not match { action, assessment } shape");
      }
      if (e.action.trim() === "" || e.assessment.trim() === "") throw new Error("row has an empty action or assessment");
    }
    return { rows: rows as PlanRow[] };
  },
  // By SUBJECT, not verbatim: patientPlan is raw treatment objects, so the model answers "Tirzepatide", not "Tirzepatide 9mg/week".
  checkAgainstInput: (context, result) => {
    const { rows } = result as { rows: PlanRow[] };
    const planned = new Map(
      (context.patientPlan as TreatmentItem[]).map((t) => [labelSubject(treatmentLabel(t)), treatmentLabel(t)]),
    );
    const seen = new Set<string>();
    for (const row of rows) {
      const subject = labelSubject(row.action.trim());
      if (!planned.has(subject)) {
        throw new Error(`aiOnPlan: action "${row.action.trim()}" matches no Patient Plan action`);
      }
      if (seen.has(subject)) throw new Error(`aiOnPlan: action "${row.action.trim()}" appears more than once`);
      seen.add(subject);
    }
    // Coverage, as finding-assemble.ts checks on the monolith path: a skipped action would read as "nothing to say".
    const unanswered = [...planned.entries()].filter(([subject]) => !seen.has(subject)).map(([, label]) => label);
    if (unanswered.length > 0) {
      throw new Error(`aiOnPlan: ${unanswered.length} planned action(s) went unassessed (${unanswered.join(", ")})`);
    }
  },
  mergeInto: (client, result) => {
    const { rows } = result as { rows: PlanRow[] };
    return { ...client, finding: { ...client.finding!, planAssessmentRows: rows } };
  },
};
