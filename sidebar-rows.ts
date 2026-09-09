// The two row SHAPES the sidebar renders, as a plain .ts module.
//
// Same reason sidebar-labels.ts exists (see its header): a type exported from a .svelte file can
// only be resolved by svelte-check, never by plain `tsc`. These two were declared inside
// SidebarLeafList.svelte / SidebarGroupList.svelte and imported by a dozen pure modules
// (treatment-bucket, sidebar-leaf-mappers, every *-sidebar-groups builder), which put those
// modules — and everything in scripts/ that imports them — beyond the reach of any Node-side type
// check. The components keep the rendering; the shape lives here.

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
  // W48 — optional per-row quick-add, for group rows that are really navigation targets in
  // disguise (Profile's Bio/Allergies/Family) rather than an in-page filter. Same class/
  // aria-label convention as the top-level row's own `.side-row-action` (Sidebar.svelte) so
  // existing selectors keyed on that convention (e.g. e2e's
  // `.side-row-action[aria-label="Add allergy"]`) keep resolving. W52 — trails the label
  // (mirrors ChatThreadList's trailing `.row-actions`) rather than leading it, so the label
  // itself sits flush left with no reserved gutter.
  action?: { label: string; onClick: () => void };
  // W58 — this group's individual items, already anchored (same anchors the sidebar SEARCH
  // feature's results already scroll to) — shown nested/indented when the row's chevron is
  // expanded. Absent (not empty) means "no chevron for this row" (e.g. Profile's Bio/
  // Allergies/Family, which are real navigation, not a filter group with members to list).
  children?: SidebarLeafRow[];
  // W58 — Notes/Study's sole "Ungrouped" row starts expanded (matches their pre-W58
  // always-visible behavior); every other section's rows start collapsed.
  defaultExpanded?: boolean;
}
