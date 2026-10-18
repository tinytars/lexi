// M102 — the sidebar's Reports lower zone: same pattern as glossary-sidebar-groups.ts, but a
// report row (reportSidebarRows, keyed by SourceRecord.id) is one level coarser than a diagnosis
// (finding.diseaseResults is keyed by DiseaseEntry.id) — a report's group is its FIRST linked
// diagnosis's group. A report with no diagnoses, or none yet tagged, simply has no system row; it
// is still listed under All, which is every report, flat.

import type { Client } from "./types";
import type { SidebarGroupRow } from "@tinytars/frame/sidebar-rows";
import { ALL_GROUP_LABEL, ALL_GROUP_KEY } from "./sidebar-labels";
import { groupBySystem } from "@pablotech/akesi/system-groups";
import { reportSidebarRows } from "./sidebar-leaf-rows";
import { systemGroupRows } from "./sidebar-system-rows";

/**
 * Which body system a report belongs to: the group of its FIRST linked diagnosis. Exported because
 * HealthReports.svelte needs the identical answer to filter its cells to the selected system — a
 * second copy here is how the sidebar and the body end up disagreeing about where a report lives.
 * `undefined` = not tagged yet, which is why no "Uncategorized" row is emitted below.
 */
export function reportSystemLookup(client: Client): (sourceId: string) => string | undefined {
  const diseases = client.factors?.diseases ?? [];
  const groupByDiseaseId = new Map((client.finding?.diseaseResults ?? []).map((r) => [r.diseaseId, r.group] as const));
  return (sourceId) => {
    const dx = diseases.find((d) => d.sourceId === sourceId);
    return dx ? groupByDiseaseId.get(dx.id) : undefined;
  };
}

export function reportSidebarGroups(client: Client): SidebarGroupRow[] {
  const rows = reportSidebarRows(client);
  const groupOfReport = reportSystemLookup(client);
  const grouped = groupBySystem(client, rows, (r) => groupOfReport(r.key));
  // W58 — the All row is every report, flat; each system row's children are groupBySystem's own
  // per-system rows. W61 — no trailing "Uncategorized" row (owner decision): an untagged report is
  // still reachable under All, and a row existing only to say "these have no system yet" was noise
  // on a list whose whole point is to be navigable.
  const out: SidebarGroupRow[] = [
    { key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: rows.length, children: rows },
    ...systemGroupRows(grouped, { key: (system) => `system:${system}`, includeUncategorized: false, children: (r) => r }),
  ];
  return out;
}
