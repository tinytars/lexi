// The per-body-system sidebar rows, built once.
//
// Three builders (glossary, markers, reports) each carried the same ladder: call groupBySystem,
// build a `countBySystem` map from its result, loop `systemOrder(client)` skipping any system whose
// count is 0, then optionally append an "Uncategorized" row — recovering each system's rows with a
// `grouped.find(...)` inside the loop.
//
// All of that re-derives what groupBySystem already returned. It yields `[...systemOrder,
// UNCATEGORIZED].filter(has rows)` — already in order, already excluding empty systems, already
// carrying each system's rows. The count map and the per-system `find` were rebuilding an answer
// that was sitting in the variable above them, three times, with three chances to drift.
//
// What genuinely differs between the three stays a parameter: the key prefix (`system:` vs
// `level:`), whether an Uncategorized row is wanted (Reports deliberately omits one — W61 owner
// decision, since its All row already reaches an untagged report), how a row maps to a leaf, and
// Markers' `title` tooltip. Nothing else.
import type { SidebarGroupRow, SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
import { UNCATEGORIZED } from "@pablotech/akesi/system-groups";
import { ALL_GROUP_KEY, ALL_GROUP_LABEL } from "./sidebar-labels";

/** The label an Uncategorized row shows. The KEY keeps UNCATEGORIZED's own value — that string is
 *  the LLM-facing group name and the sidebar keys tests assert on. */
const UNCATEGORIZED_LABEL = "Uncategorized";

export interface SystemRowOptions<T> {
  /** `system:` for glossary/reports, `level:` for markers — the prefix its section narrows on. */
  key: (system: string) => string;
  children: (rows: T[]) => SidebarLeafRow[];
  /** Reports passes false: an untagged report is reachable under All, and a row that exists only to
   *  say "these have no system yet" was noise on a list whose point is to be navigable. */
  includeUncategorized?: boolean;
  /** Markers' per-row tooltip (the markerLevels basis sentence). */
  title?: string;
}

/** `count` is REQUIRED in the return type, not optional as on SidebarGroupRow: every row here has a
 *  count by construction, and markers' own MarkerSidebarGroup requires one. */
export function systemGroupRows<T>(
  grouped: { system: string; rows: T[] }[] | null,
  opts: SystemRowOptions<T>,
): (SidebarGroupRow & { count: number })[] {
  const includeUncategorized = opts.includeUncategorized ?? true;
  return (grouped ?? [])
    .filter((g) => g.system !== UNCATEGORIZED || includeUncategorized)
    .map((g) => ({
      key: opts.key(g.system),
      label: g.system === UNCATEGORIZED ? UNCATEGORIZED_LABEL : g.system,
      count: g.rows.length,
      ...(opts.title === undefined ? {} : { title: opts.title }),
      children: opts.children(g.rows),
    }));
}

/**
 * The other shape: sections that already know each item's system and want a row per system in
 * `systemOrder`, INCLUDING empty ones.
 *
 * Hypothesis and Exploration were byte-identical here, down to the All row and the sortPinnedFirst.
 * They differ from the three above in two ways that are deliberate, not accidental: they keep a
 * zero-count row (an established body system with no ideas yet is still somewhere to navigate to,
 * and its emptiness is the information), and their keys are the bare system name rather than a
 * prefixed one.
 */
export function systemRowsFromMap(
  systems: string[],
  childrenBySystem: Map<string, SidebarLeafRow[]>,
  sort: (rows: SidebarLeafRow[]) => SidebarLeafRow[],
): { all: SidebarGroupRow & { count: number }; systems: (SidebarGroupRow & { count: number })[] } {
  const rows = systems.map((system) => {
    const children = childrenBySystem.get(system) ?? [];
    return { key: system, label: system, count: children.length, children: sort(children) };
  });
  const all = sort(rows.flatMap((s) => s.children ?? []));
  return {
    all: { key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: all.length, children: all },
    systems: rows,
  };
}
