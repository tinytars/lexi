// M76 Phase 2 — the sidebar's Markers lower zone: one row per group MarkersTab can narrow to
// (Ratios, then each established body system), so the sidebar and MarkersTab agree on both the
// set of groups and their counts without either reimplementing the other's derivation.

import type { Client } from "./types";
import { buildMarkerRatios } from "./marker-ratios";
import { flatMarkers, markerSystemIndex, type Marker } from "./marker-grid";
import { groupBySystem, systemAnalysisEstablished } from "@pablotech/akesi/system-groups";
import { markerLevelLeaf, markerRatioLeaf } from "./sidebar-leaf-mappers";
import type { SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
import { ALL_GROUP_LABEL, ALL_GROUP_KEY } from "./sidebar-labels";
import { sortPinnedFirst } from "./pin-sort";
import { systemGroupRows } from "./sidebar-system-rows";

export interface MarkerSidebarGroup {
  key: string;
  label: string;
  count: number;
  title?: string;
  children?: SidebarLeafRow[];
}

// Ungrouped (M96 §B — every marker, flat) and Ratios rows always present (even at 0 — a client
// with no ratios yet still has the group), then one row per systemOrder(client) entry that
// actually has markers classified into it — an established-but-empty system (markerGroups hasn't
// caught up to a newly declared disease risk, or to newly imported markers) is skipped rather than
// shown as a dead (0) row, and any markers markerGroups couldn't classify surface as a trailing
// "Uncategorized" row instead of silently becoming unreachable.
export function markerSidebarGroups(client: Client): MarkerSidebarGroup[] {
  const flat = flatMarkers(client);
  const index = markerSystemIndex(client);
  const grouped = groupBySystem(client, flat, (m) => index.get(m.name));
  // W62 — a marker's pin IS watchlist membership and a ratio's is pinnedRatios; both already exist
  // and are toggled from the body (MarkerChart's star). The sidebar reads the same two lists rather
  // than growing a third, so a star set in either place shows in both.
  const watch = new Set(client.watchlist ?? []);
  const pinnedRatioNames = new Set(client.pinnedRatios ?? []);
  const levelLeaf = (m: Marker) => markerLevelLeaf(m, watch.has(m.name));
  const levelsBasis = client.finding?.basis?.markerLevels;
  const ratios = buildMarkerRatios(client);
  const rows: MarkerSidebarGroup[] = [
    { key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: flat.length, children: sortPinnedFirst(flat.map(levelLeaf)) },
    { key: "ratios", label: "Ratios", count: ratios.length, children: sortPinnedFirst(ratios.map((rv) => markerRatioLeaf(rv, pinnedRatioNames.has(rv.ratio.name)))) },
    ...systemGroupRows(grouped, {
      key: (system) => `level:${system}`,
      title: levelsBasis,
      children: (r) => sortPinnedFirst(r.map(levelLeaf)),
    }),
  ];
  return rows;
}

// Grouping isn't established yet (no Finding disease list) — Sidebar shows a placeholder note
// instead of (absent) per-system rows.
export function markerGroupsPending(client: Client): boolean {
  return !systemAnalysisEstablished(client);
}
