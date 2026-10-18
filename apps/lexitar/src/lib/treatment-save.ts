import type { Client, TreatmentItem } from "./types";
import { renameAssessmentItems } from "@pablotech/akesi/treatment-bucket";
import { attachmentsOf } from "./attachment-keys";
import { planMedicineFanout, applyMedicineFanoutPatch } from "./treatment-medicine-fanout";
import { fanoutReason } from "./treatment-reason-fanout";

// "medicine" = Name/Reason/Kind (true of the drug); "entry" = dates/dose/timing (one dose period);
// "all" = both, for Add and for the temporal tabs.
export type TreatmentFieldScope = "all" | "medicine" | "entry";

export interface TreatmentSaveInput {
  item: TreatmentItem;
  scope: TreatmentFieldScope;
  editingIndex: number | null;
  editGroupName: string | null;
  rows: TreatmentItem[];
}

export type TreatmentSavePlan =
  | { kind: "medicine"; name: string; prevName: string; patch: Partial<TreatmentItem>; regenGroups: boolean }
  | { kind: "entry"; name: string; item: TreatmentItem; index: number | null };

const lower = (s: string) => s.trim().toLowerCase();

export function planTreatmentSave({ item, scope, editingIndex, editGroupName, rows }: TreatmentSaveInput): TreatmentSavePlan {
  if (scope !== "medicine") return { kind: "entry", name: item.name, item, index: editingIndex };
  const prevName = editGroupName!;
  const { name, reason, kind, description, maker, ingredients, links, administration, extracted, rawCaptureAttachmentKeys, rawCaptureText } = item;
  const prevAdministration = rows.find((x) => lower(x.name) === lower(prevName))?.administration;
  const { patch, relabelUnit } = planMedicineFanout(
    { name, reason, kind, description, maker, ingredients, links, administration, extracted, rawCaptureAttachmentKeys, rawCaptureText, attachments: attachmentsOf(item) },
    prevAdministration,
  );
  // A unit relabel changes every row's treatmentLabel(), stale-matching the treatmentGroups refs,
  // which have no per-drug scoping — only a forced full regen rewrites them.
  return { kind: "medicine", name, prevName, patch, regenGroups: relabelUnit != null };
}

// Called once on the draft and once on the persist payload, so each gets its own copy of the row.
export function applyTreatmentSave(c: Client, plan: TreatmentSavePlan): void {
  const rows = c.factors?.treatments;
  if (plan.kind === "medicine") {
    renameAssessmentItems(c.finding?.treatment ?? [], plan.prevName, plan.name);
    applyMedicineFanoutPatch(rows, lower(plan.prevName), plan.patch);
    return;
  }
  const row = { ...plan.item };
  if (plan.index !== null) rows![plan.index] = row;
  else rows!.push(row);
  fanoutReason(rows, row.id, lower(row.name), row.reason);
}
