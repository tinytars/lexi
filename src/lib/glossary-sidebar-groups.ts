// M96 Phase 10 — the sidebar's Glossary lower zone: unlike Questions (§G, a doctorConversation-derived
// non-body-system taxonomy), definitions[].group is a real body-system value (Phase 9's validator ties
// it to disease[].group), so this reuses groupBySystem/UNCATEGORIZED exactly like Markers/Hypothesis/
// Exploration rather than mirroring questions-sidebar-groups.ts's bespoke derivation.

import type { Client } from "./types";
import type { SidebarGroupRow } from "@tinytars/frame/sidebar-rows";
import { ALL_GROUP_LABEL, ALL_GROUP_KEY } from "./sidebar-labels";
import { groupBySystem } from "@pablotech/akesi-pil/system-groups";
import { termLeaf } from "./sidebar-leaf-mappers";
import { isPinnedItem } from "@pablotech/akesi-pil/item-registry";
import { sortPinnedFirst } from "./pin-sort";
import { systemGroupRows } from "./sidebar-system-rows";

export function glossarySidebarGroups(client: Client): SidebarGroupRow[] {
  const defs = client.finding?.definitions ?? [];
  const grouped = groupBySystem(client, defs, (d) => d.group);
  const leaf = (d: { term: string }) => termLeaf(d, isPinnedItem(client, "glossary", d.term));
  const rows: SidebarGroupRow[] = [
    { key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: defs.length, children: sortPinnedFirst(defs.map(leaf)) },
    ...systemGroupRows(grouped, {
      key: (system) => `system:${system}`,
      children: (r) => sortPinnedFirst(r.map(leaf)),
    }),
  ];
  return rows;
}
