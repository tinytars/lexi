import type { Client, TreatmentItem } from "./types";
import { bucketOf, groupByName, dateGaps, type Bucket, type DateGapVerdict, type NamedTreatmentGroup } from "@pablotech/akesi/treatment-bucket";
import { groupBySystem } from "@pablotech/akesi/system-groups";
import { groupBucket, partitionGroupsByBucket } from "./treatment-sidebar";
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
  // The bucket every group in this view belongs to, or null in All, where each card badges its own.
  // Inside one temporal view every card would carry the same badge, so there is nothing to say.
  bucket: Bucket | null;
}

// 2026-11-06 — group FIRST, then filter the groups. Filtering rows and grouping what survived is
// what put one drug under three views at once: titration is repeated same-name rows, so a drug
// being taken today with an ended earlier dose had a row in Past and rendered a card there. A group
// now carries ALL of its drug's rows whichever view selected it — the view decides which drugs
// appear, groupDisplay below decides which of a drug's rows are shown.
export function editView(rows: TreatmentItem[], view: TreatmentView, today: string): EditView {
  const groups = groupByName(rows, today);
  const scoped = view === "medicine" ? groups : partitionGroupsByBucket(groups, today)[view];
  return {
    // Any pinned row pins the drug — the card is the drug, and `rows[0]` is one dose period of it.
    // This is also what medicineNameLeaf has always done, so the two lists agreed only by accident.
    groups: sortPinnedFirst(scoped, (g) => g.rows.some((r) => r.pinned)),
    label: VIEW_LABEL[view],
    bucket: view === "medicine" ? null : view,
  };
}

// A long titration (Tirzepatide runs to 11 dose periods) buries every other drug below it, so a
// collapsed card shows its most recent few.
export const MEDICINE_PREVIEW_ROWS = 3;

export interface DisplayRow {
  row: TreatmentItem;
  // Index into the drug's FULL row set, which is what dateGaps is computed over — see below.
  i: number;
  outOfBucket: boolean;
}

export interface GroupDisplay {
  rows: DisplayRow[];
  toggleLabel: string;
  showToggle: boolean;
  // gaps[i] describes the boundary between full-set rows i and i+1.
  gaps: DateGapVerdict[];
}

// Which of a drug's dose periods its card shows, and what the one toggle says.
//
// The bucket chooses which drugs appear; this chooses which of the chosen drug's rows are on screen.
// Collapsed, a temporal view shows that bucket's own rows (capped) — which is what the view is for —
// and expanding reveals the drug's whole timeline, out-of-bucket rows marked rather than hidden. That
// replaces the old length-only truncation: before this, a drug's history outside the active view was
// unreachable from it, so Ongoing could show one current dose period with the rest of the course
// nowhere.
//
// Indices are into the full set deliberately. dateGaps is computed over every row, so a flag means
// what its text says ("gap in coverage before the entry below"); over a filtered set it does not —
// in a Past view of a drug with rows [past, ongoing, past] the two past rows render adjacent and the
// boundary between them has a current dose period inside it.
export function groupDisplay(
  g: NamedTreatmentGroup,
  bucket: Bucket | null,
  today: string,
  expanded: boolean,
): GroupDisplay {
  const full: DisplayRow[] = g.rows.map((row, i) => ({
    row,
    i,
    outOfBucket: bucket !== null && bucketOf(row, today) !== bucket,
  }));
  const collapsed = full.filter((d) => !d.outOfBucket).slice(0, MEDICINE_PREVIEW_ROWS);
  return {
    rows: expanded ? full : collapsed,
    toggleLabel: expanded
      ? "⌃ Show fewer"
      : bucket === null
        ? `⌄ Show all ${g.rows.length}`
        : `⌄ Show full history (${g.rows.length})`,
    // Whether expanding reveals anything, which is a property of the collapsed set and not of the
    // row count: a drug with two rows one of which is out of bucket has a toggle, and a drug with
    // three in-bucket rows and nothing else does not.
    showToggle: collapsed.length < full.length,
    gaps: dateGaps(g.rows),
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

// Which view a deep-linked treatment anchor should switch to: matched against every drug, not any
// view's groups, since the owning bucket is by definition not the one being shown.
//
// Takes rows rather than a Client so the caller can pass the live draft. The anchor arrives from a
// save as well as from a sidebar click, and the client has not caught up yet at that point — asking
// it would resolve the bucket the edited drug was in before the edit.
export function groupBucketForAnchor(rows: TreatmentItem[], anchor: string, today: string): Bucket | undefined {
  const g = findByAnchor(groupByName(rows, today), anchor, (x) => treatmentAnchor(x.name));
  return g && groupBucket(g.rows, today);
}

export function treatmentModalLabel(scope: TreatmentFieldScope, editingIndex: number | null): string {
  if (scope === "medicine") return "Edit medicine";
  if (scope === "entry") return "Edit dose entry";
  return editingIndex !== null ? "Edit treatment" : "Add treatment";
}
