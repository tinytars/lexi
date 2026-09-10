// The two row SHAPES the sidebar renders, as a plain .ts module.
//
// A type exported from a .svelte file can only be resolved by svelte-check, never by plain `tsc`.
// These two were declared inside SidebarLeafList.svelte / SidebarGroupList.svelte and imported by
// pure modules that build sidebar rows, which put those modules — and any Node-side script that
// imports them — beyond the reach of any Node-side type check. The components keep the rendering;
// the shape lives here.

export interface SidebarLeafRow {
  key: string;
  label: string;
  anchor: string;
  pinned?: boolean;
  // The vault record this row stands for, when the row's own `key` is not that id — Hypothesis
  // keys its rows positionally (topic+side+index, because that is what its anchor needs) while
  // the record behind a patient idea is a DecisionEntry. `undefined` means "key IS the id";
  // `null` means "this row has no record at all" (an AI-proposed idea), so it cannot be pinned.
  itemId?: string | null;
  // Falls back to `label` when absent — lets a truncated label (e.g. Notes' preview text) still
  // filter against the full underlying text.
  searchText?: string;
  // An id to put on the row element itself. Only set where the SIDEBAR row is the only place that
  // item exists (Chat's threads) — everywhere else the main panel already owns the anchor id, and
  // a duplicate would capture getElementById and break scroll-to.
  domId?: string;
}

export interface SidebarGroupRow {
  key: string;
  label: string;
  count?: number;
  title?: string;
  // Optional per-row quick-add, for group rows that are really navigation targets in disguise
  // rather than an in-page filter. Same class/aria-label convention as the top-level row's own
  // `.side-row-action` so a caller's existing selectors keyed on that convention keep resolving.
  // Trails the label rather than leading it, so the label itself sits flush left with no reserved
  // gutter.
  action?: { label: string; onClick: () => void };
  // This group's individual items, already anchored (the same anchors a caller's search feature
  // would scroll to) — shown nested/indented when the row's chevron is expanded. Absent (not
  // empty) means "no chevron for this row" — real navigation, not a filter group with members to
  // list.
  children?: SidebarLeafRow[];
  // A row can opt into starting expanded rather than collapsed, e.g. a section's sole "Ungrouped"
  // row that should stay always-visible.
  defaultExpanded?: boolean;
}
