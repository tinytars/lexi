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
// are always resolvable, no "pending" state). Ongoing/Planned/Past are counted raw/uncollapsed — one
// row per titration step, matching UnifiedTreatment.svelte's `editModel` (the only reachable view:
// canEdit is always true, see UnifiedTreatment.svelte:75). Collapsing by name here would fold an
// ended dose step into its drug's current ongoing step, undercounting Past even though editModel
// lists that step there.
//
// "All" leads and is the tab's default. It replaced the old flat "Ungrouped" row, which listed the
// same treatments as loose rows with no per-drug history — strictly less than what All shows, so it
// was dropped rather than kept alongside. The `medicine` key is retained as the stable persisted
// nav identifier. All is the one row grouped by NAME, not bucket: an
// audit view of every drug's full dose/timeframe history in one place (see groupByName/dateGaps),
// answering "did this drug's coverage actually stay continuous" — a question the three temporal
// buckets can't answer since one drug's titration steps are scattered across all three of them.
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
