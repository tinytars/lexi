// M76 Phase 4 — the sidebar's Hypothesis lower zone: one row per body system Hypothesis can narrow
// to, so the sidebar and FutureTreatment agree on both the set of groups and their counts without
// either reimplementing the other's derivation. Unlike Markers (one row per system, plus a
// "ratios" pseudo-group) there's no analog to disambiguate against, so the key is the bare system
// name — safe since Markers and Hypothesis never share a sidebar row set at the same time.

import type { Client } from "./types";
import { buildHypothesisGroups } from "./treatment-groups";
import { systemAnalysisEstablished, systemOrder } from "@pablotech/akesi/system-groups";
import { ideaLeaf } from "./sidebar-leaf-mappers";
import type { SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
import { sortPinnedFirst } from "./pin-sort";
import { systemRowsFromMap } from "./sidebar-system-rows";

export interface HypothesisSidebarGroup {
  key: string;
  label: string;
  count: number;
  children?: SidebarLeafRow[];
}

// One row per distinct system in systemOrder(client) order (many topics can share a system — see
// FutureTreatment.svelte's groups/render loop). W59 — count is children.length (each individual
// patient/ai idea across every topic in the system), matching every other group-list section's
// invariant; previously counted resolved topic-groups instead, a coarser number than what
// expanding the row actually showed. Sourced from buildHypothesisGroups (not the raw
// resolveTreatmentGroups, already used by search-index.ts) so count/children are the exact same
// resolved/filtered/sorted list HypothesisTopicCard.svelte actually renders —
// resolveTreatmentGroups's raw patient list still includes "plan"-kind items buildHypothesisGroups
// filters out. Empty (not established) → Sidebar shows the pending note instead of any rows.
export function hypothesisSidebarGroups(client: Client): HypothesisSidebarGroup[] {
  if (!systemAnalysisEstablished(client)) return [];
  const resolved = buildHypothesisGroups(client) ?? [];
  const childrenBySystem = new Map<string, SidebarLeafRow[]>();
  for (const g of resolved) {
    const leaves = childrenBySystem.get(g.system) ?? [];
    g.patient.forEach((p, index) => leaves.push(ideaLeaf(g.topic, "patient", index, p.label, { pinned: p.pinned, itemId: p.id })));
    g.ai.forEach((a, index) => leaves.push(ideaLeaf(g.topic, "ai", index, a.intervention, { itemId: null })));
    childrenBySystem.set(g.system, leaves);
  }
  // W61 — an All row over every idea in every system, matching every other section. Its key is the
  // shared ALL_GROUP_KEY, which FutureTreatment reads as "render every system" rather than narrowing to one.
  // W64 — the row-building itself is shared (sidebar-system-rows.ts); this and Exploration/Hypothesis
  // were byte-identical.
  const { all, systems } = systemRowsFromMap(systemOrder(client), childrenBySystem, sortPinnedFirst);
  return [all, ...systems];
}

// Grouping isn't established yet (no Finding disease list) — Sidebar shows a placeholder note
// instead of (absent) per-system rows.
export function hypothesisGroupsPending(client: Client): boolean {
  return !systemAnalysisEstablished(client);
}
