// The sidebar's Recommended Markers rows — nested under Notes, between Questions and Glossary.
//
// One row per body-system group, matching the CELLS the page renders (RecommendedMarkers.svelte
// draws one turn cell per group). That is the rule Exploration and Analysis adopted: the sidebar
// lists exactly what the body renders as cells, never something finer or coarser.
import type { Client } from "./types";
import type { SidebarGroupRow, SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
import { ALL_GROUP_LABEL, ALL_GROUP_KEY } from "./sidebar-labels";
import { healthMarkersGroupAnchor } from "./anchor";
import { isPinnedItem, itemRecordId } from "@pablotech/akesi-pil/item-registry";
import { sortPinnedFirst } from "./pin-sort";

export interface RecommendedMarkerGroup {
  group: string;
  markers: { name: string; rationale: string }[];
}

/** The groups that actually have markers — the same filter the component applies. */
export function recommendedMarkerGroups(client: Client): RecommendedMarkerGroup[] {
  return (client.finding?.healthMarkers?.recommended ?? []).filter((g) => g.markers?.length);
}

export function recommendedMarkerLeaf(g: RecommendedMarkerGroup, pinned?: boolean): SidebarLeafRow {
  // The CELL is the body-system group, so the group name is the pinnable item — pinning
  // "Cardiovascular Risk" says "look into this system", which is what the cell is.
  return { key: g.group, label: g.group, anchor: healthMarkersGroupAnchor(g.group), itemId: itemRecordId("recommendedMarkers", g.group), pinned };
}

export function recommendedMarkersSidebarGroups(client: Client): SidebarGroupRow[] {
  const children = sortPinnedFirst(
    recommendedMarkerGroups(client).map((g) => recommendedMarkerLeaf(g, isPinnedItem(client, "recommendedMarkers", g.group))),
  );
  return [{ key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: children.length, children }];
}
