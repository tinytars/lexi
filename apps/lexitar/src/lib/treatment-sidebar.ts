// W72 — the sidebar half of the treatment domain, split out of treatment-bucket.ts.
//
// docs/cross-app/06 names this as one of three things blocking a clean brain extraction: the pure
// clinical logic in treatment-bucket.ts reached Svelte sidebar components through its last ~60 lines,
// so the whole module — bucketing, dose formatting, assessment lookup — was pinned to the app's UI by
// three imports it did not otherwise need.
//
// Nothing here changed. It moved.

import type { Client, TreatmentItem } from "./types";
import { treatmentLeaf, medicineNameLeaf } from "./sidebar-leaf-mappers";
import type { SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
import { ALL_GROUP_LABEL } from "./sidebar-labels";
import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
import { bucketOf, groupByName, type Bucket } from "@pablotech/akesi/treatment-bucket";
import { sortPinnedFirst } from "./pin-sort";

export interface TreatmentSidebarBucket {
  key: Bucket | "medicine";
  label: string;
  count: number;
  title?: string;
  children?: SidebarLeafRow[];
}

// M76 Phase 3 — the sidebar's Treatment lower zone: always exactly 4 rows (unlike Markers, buckets
// are always resolvable, no "pending" state).
//
// Ongoing/Planned/Past counted raw/uncollapsed until 2026-11-06, one row per titration step. The
// as-built reason stood here and is kept rather than deleted: "Collapsing by name here would fold an
// ended dose step into its drug's current ongoing step, undercounting Past even though editModel
// lists that step there." That objection is answered by PRIORITY rather than by collapsing. An ended
// dose step whose drug is still being taken is deliberately no longer counted in Past, because Past
// now means the DRUG is finished — which is what the four labels say, and the counts could not sum
// to All's while a titrated drug was counted in two of them at once. See groupBucket below.
//
// "All" leads and is the tab's default. It replaced the old flat "Ungrouped" row, which listed the
// same treatments as loose rows with no per-drug history — strictly less than what All shows, so it
// was dropped rather than kept alongside. The `medicine` key is retained as the stable persisted
// nav identifier. All is the one row grouped by NAME, not bucket: an
// audit view of every drug's full dose/timeframe history in one place (see groupByName/dateGaps).
// It is NOT a fourth bucket — it is the unfiltered list, every drug with every row, whichever
// temporal bucket that drug also files under, which is what makes the other three sum to it.
/**
 * The one place a treatment list is split into its three temporal buckets.
 *
 * There were four structural copies of this loop plus ten inline `bucketOf` filters, which is how
 * the buckets came to disagree in the first place. Callers that need one bucket take one field off
 * the result rather than re-deriving membership.
 */
export function partitionByBucket<T extends Pick<TreatmentItem, "start" | "end">>(
  items: T[],
  today: string,
): Record<Bucket, T[]> {
  const out: Record<Bucket, T[]> = { ongoing: [], planned: [], past: [] };
  for (const t of items) out[bucketOf(t, today)].push(t);
  return out;
}

/**
 * Which bucket a DRUG belongs to — a priority fold over all of its rows, never any one row's.
 *
 * Ongoing if a dose period covers today; Planned if one is scheduled and none covers today; Past if
 * neither. That is the three filter labels read literally, and it is what makes the three a
 * partition: a titrated drug has rows in two or three buckets and still belongs to exactly one.
 *
 * Deliberately NOT groupByName's GROUP_BUCKET_ORDER rule, which reads the newest-START row
 * (@pablotech/akesi/treatment-bucket.ts) to order groups. The two disagree on exactly one shape — an
 * open-ended current row plus a later planned row — where newest-start says planned and this says
 * ongoing. You are taking it, so ongoing is right; that rule stays as it is, for sort order only.
 *
 * Nor is it collapseByName's representative, which is wrong in both directions: a drug whose morning
 * row is open while its evening row is closed out collapses to a finished period, and a drug taken
 * years ago and scheduled to resume collapses to an open one. A single representative cannot encode
 * "has a current period AND a future one", which is the case every titrated drug is in.
 *
 * No rows is past — vacuously, nothing is being taken and nothing is scheduled. groupByName never
 * emits an empty group, so this is a total function rather than a reachable case.
 */
export function groupBucket(rows: Pick<TreatmentItem, "start" | "end">[], today: string): Bucket {
  let planned = false;
  for (const r of rows) {
    const b = bucketOf(r, today);
    if (b === "ongoing") return "ongoing";
    if (b === "planned") planned = true;
  }
  return planned ? "planned" : "past";
}

/**
 * partitionByBucket's drug-level counterpart: the one place a list of named groups is split into the
 * three temporal buckets. Each group lands in exactly one, carrying ALL of its rows — the bucket
 * chooses which drugs appear, never which of a drug's rows survive.
 *
 * Generic over the group rather than fixed to NamedTreatmentGroup so the view model can pass its own
 * enriched shape through without a second copy of the loop.
 */
export function partitionGroupsByBucket<G extends { rows: Pick<TreatmentItem, "start" | "end">[] }>(
  groups: G[],
  today: string,
): Record<Bucket, G[]> {
  const out: Record<Bucket, G[]> = { ongoing: [], planned: [], past: [] };
  for (const g of groups) out[groupBucket(g.rows, today)].push(g);
  return out;
}

export function treatmentSidebarBuckets(client: Client, today: string): TreatmentSidebarBucket[] {
  const all = treatmentsOf(client);
  const named = groupByName(all, today);
  const byBucket = partitionByBucket(all, today);
  return [
    { key: "medicine", label: ALL_GROUP_LABEL, count: named.length, title: "Full dose/timeframe history per drug.", children: sortPinnedFirst(named.map(medicineNameLeaf)) },
    { key: "ongoing", label: "Ongoing", count: byBucket.ongoing.length, title: "Currently being taken.", children: sortPinnedFirst(byBucket.ongoing.map(treatmentLeaf)) },
    {
      key: "planned",
      label: "Planned",
      count: byBucket.planned.length,
      title: "Not started yet — a future start date.",
      children: sortPinnedFirst(byBucket.planned.map(treatmentLeaf)),
    },
    {
      key: "past",
      label: "Past",
      count: byBucket.past.length,
      title: "Discontinued — kept for history, still commented on for context.",
      children: sortPinnedFirst(byBucket.past.map(treatmentLeaf)),
    },
  ];
}
