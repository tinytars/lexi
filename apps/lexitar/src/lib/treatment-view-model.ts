import type { Client, TreatmentItem } from "./types";
import { bucketOf, collapseByName, groupByName, type Bucket, type NamedTreatmentGroup } from "@pablotech/akesi/treatment-bucket";
import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
import { groupBySystem } from "@pablotech/akesi/system-groups";
import { partitionByBucket } from "./treatment-sidebar";
import { sortPinnedFirst } from "./pin-sort";
import { findByAnchor, treatmentAnchor } from "./anchor";
import type { TreatmentFieldScope } from "./treatment-save";

export type TreatmentView = "medicine" | Bucket;

const VIEW_LABEL: Record<TreatmentView, string> = { medicine: "", ongoing: "ongoing ", planned: "planned ", past: "past " };

// Anything else — including the retired "ungrouped" a saved nav memory may still hold — is All.
export function resolveTreatmentView(activeGroup: string | null | undefined): TreatmentView {
  return activeGroup === "ongoing" || activeGroup === "planned" || activeGroup === "past" ? activeGroup : "medicine";
}

export interface EditView {
  groups: NamedTreatmentGroup[];
  label: string;
  badge: boolean;
}

// Grouping after the bucket filter keeps each temporal view to its own dose periods; inside one
// bucket every card would carry the same badge, so only All shows it.
export function editView(rows: TreatmentItem[], view: TreatmentView, today: string): EditView {
  const scoped = view === "medicine" ? rows : partitionByBucket(rows, today)[view];
  return {
    groups: sortPinnedFirst(groupByName(scoped, today), (g) => g.rows[0].pinned),
    label: VIEW_LABEL[view],
    badge: view === "medicine",
  };
}

export interface ReadView<R> {
  rows: R[];
  grouped: { system: string; rows: R[] }[] | null;
  label: string;
}

export function readView<R extends { group?: string }>(client: Client, model: Record<Bucket, R[]>, view: TreatmentView): ReadView<R> {
  const rows = view === "medicine" ? [...model.ongoing, ...model.planned, ...model.past] : model[view];
  return { rows, grouped: groupBySystem(client, rows, (r) => r.group), label: VIEW_LABEL[view] };
}

// Matched against the full collapsed set, not any view's rows, since the owning bucket may not be shown.
export function bucketForAnchor(client: Client, anchor: string, today: string): Bucket | undefined {
  const t = findByAnchor(collapseByName(treatmentsOf(client)), anchor, (x) => treatmentAnchor(x.name));
  return t && bucketOf(t, today);
}

export function treatmentModalLabel(scope: TreatmentFieldScope, editingIndex: number | null): string {
  if (scope === "medicine") return "Edit medicine";
  if (scope === "entry") return "Edit dose entry";
  return editingIndex !== null ? "Edit treatment" : "Add treatment";
}
