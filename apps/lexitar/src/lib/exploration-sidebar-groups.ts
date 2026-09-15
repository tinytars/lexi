// M80 — the sidebar's Exploration lower zone: one row per body system, mirroring
// hypothesis-sidebar-groups.ts (bare system name key, no "ratios"-style pseudo-group) so the
// sidebar and TestsToConsider.svelte agree on both the set of groups and their counts.

import type { Client } from "./types";
import { systemAnalysisEstablished, systemOrder } from "@pablotech/akesi/system-groups";
import { buildExplorationRows } from "./exploration-rows";
import { explorationItemLeaf } from "./sidebar-leaf-mappers";
import { isPinnedItem } from "@pablotech/akesi/item-registry";
import { sortPinnedFirst } from "./pin-sort";
import { systemRowsFromMap } from "./sidebar-system-rows";
import type { SidebarLeafRow } from "@tinytars/frame/sidebar-rows";

export interface ExplorationSidebarGroup {
  key: string;
  label: string;
  count: number;
  children?: SidebarLeafRow[];
}

// One row per distinct system in systemOrder(client) order. W59 — count is children.length (each
// individual item, flattened across every cell's items[]/dueSoon[] in the system via
// buildExplorationRows so indices line up with what ExplorationCell actually renders — same
// precedent as explorationSearchLeaves), matching every other group-list section's invariant;
// previously counted (modality × system) cells instead, a coarser number than what expanding the
// row actually showed. Empty (not established) → Sidebar shows the pending note instead of rows.
export function explorationSidebarGroups(client: Client): ExplorationSidebarGroup[] {
  if (!systemAnalysisEstablished(client)) return [];
  const childrenBySystem = new Map<string, SidebarLeafRow[]>();
  for (const r of buildExplorationRows(client)) {
    const system = r.group ?? "";
    const leaves = childrenBySystem.get(system) ?? [];
    r.items.forEach((item, index) => leaves.push(explorationItemLeaf(r.group, r.type, "items", index, item, isPinnedItem(client, "exploration", item))));
    r.dueSoon.forEach((item, index) => leaves.push(explorationItemLeaf(r.group, r.type, "dueSoon", index, item, isPinnedItem(client, "exploration", item))));
    childrenBySystem.set(system, leaves);
  }
  // W61 — an All row over every item in every system, matching every other section. Its key is the
  // shared ALL_GROUP_KEY, which TestsToConsider reads as "render every system" rather than narrowing to one.
  // W64 — the row-building itself is shared (sidebar-system-rows.ts); this and Exploration/Hypothesis
  // were byte-identical.
  const { all, systems } = systemRowsFromMap(systemOrder(client), childrenBySystem, sortPinnedFirst);
  return [all, ...systems];
}

// Grouping isn't established yet (no Finding disease list) — Sidebar shows a placeholder note
// instead of (absent) per-system rows.
export function explorationGroupsPending(client: Client): boolean {
  return !systemAnalysisEstablished(client);
}
