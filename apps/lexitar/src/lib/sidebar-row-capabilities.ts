// WHICH sidebar sections offer WHICH per-row actions — one table, so the answer lives in a single
// readable place instead of being implied by which callbacks a render branch happens to pass.
//
// The owner's rule: where the cells support pinning, show the ★ with Pin/Unpin. That does NOT imply
// Rename or Delete exist in that section. A section absent from this table gets no row menu at all,
// which is deliberate — a ⋮ opening a menu of no-ops is worse than no ⋮.
import type { SidebarItemKind } from "./vault-item-ops";

// "thread" is the one kind that is NOT a vault Client list — chat threads live in their own
// encrypted per-client blob — so it is handled by the chat callbacks rather than vault-item-ops.
// It belongs in this table anyway: Chat is a section like any other, and keeping it out is exactly
// what let Chat drift into its own bespoke row in the first place.
export type RowKind = SidebarItemKind | "thread";

export interface RowCapabilities {
  kind: RowKind;
  pin: boolean;
  /** Inline rename, only where a writable label field exists (see RENAME_FIELD in vault-item-ops). */
  rename: boolean;
  delete: boolean;
}

// Keyed by Sidebar's `lowerZoneKind`, plus the two personalization sections which are their own
// section keys rather than a lower-zone kind.
const CAPABILITIES: Record<string, RowCapabilities> = {
  chat: { kind: "thread", pin: true, rename: true, delete: true },
  notes: { kind: "note", pin: true, rename: false, delete: true },
  study: { kind: "study", pin: true, rename: true, delete: true },
  allergies: { kind: "allergy", pin: true, rename: true, delete: true },
  family: { kind: "family", pin: true, rename: true, delete: true },
  hypothesis: { kind: "decision", pin: true, rename: true, delete: true },
  // A treatment row is one dose period; the All row's rows are whole medicines. Neither renames —
  // the drug name is the cross-system matching key for stored Findings (types.ts:83-85).
  treatment: { kind: "treatment", pin: true, rename: false, delete: true },
  medicine: { kind: "medicine", pin: true, rename: false, delete: false },
  // W62 — the sections that had no per-item record until this milestone. All five pin and NONE of
  // them renames or deletes, which is not an oversight:
  //   • A generated item's text is the Finding's own words. Renaming it would make the page
  //     disagree with what LexiTar actually said, and the next regeneration would overwrite the
  //     edit anyway — an edit that silently un-does itself is worse than no edit.
  //   • Deleting one deletes a line of the Finding, which the next regeneration writes straight
  //     back. Deleting a REPORT means expunging its file and every reading derived from it (the
  //     removedSources tombstone flow) — far too heavy to sit behind a row's ⋮.
  // Pin is the one action that means something here, and it means exactly one thing: mark this an
  // area of query for the next Finding (see finding-generate.ts's Areas of query block).
  healthReports: { kind: "report", pin: true, rename: false, delete: false },
  questions: { kind: "question", pin: true, rename: false, delete: false },
  glossary: { kind: "glossary", pin: true, rename: false, delete: false },
  exploration: { kind: "exploration", pin: true, rename: false, delete: false },
  analysis: { kind: "analysis", pin: true, rename: false, delete: false },
  recommendedMarkers: { kind: "recommendedMarkers", pin: true, rename: false, delete: false },
  // Markers' own two kinds: a level row is a marker (its pin IS watchlist membership, the bit the
  // app has always had), a Ratios row is a ratio (M74's separate star).
  markers: { kind: "marker", pin: true, rename: false, delete: false },
  ratios: { kind: "ratio", pin: true, rename: false, delete: false },
};

// Sections whose GROUP rows are other sections' items, so the row's kind depends on which group it
// sits under, not on the section alone. Three of the four exist because Notes hosts Questions,
// Markers and Glossary as sibling rows below its own All (sidebar-leaf-rows.ts); the fourth is
// Treatment's All row listing whole medicines while its other rows list dose periods.
const GROUP_KIND: Record<string, Record<string, string>> = {
  treatment: { medicine: "medicine" },
  markers: { ratios: "ratios" },
  notes: { docInference: "questions", healthMarkers: "recommendedMarkers", definitions: "glossary" },
};

export function capabilitiesFor(section: string | null | undefined): RowCapabilities | null {
  return (section && CAPABILITIES[section]) || null;
}

/**
 * The capabilities of one ROW: its section, narrowed by the group row it sits under when that group
 * belongs to a different section (see GROUP_KIND). This is the single entry point — Sidebar asks it
 * once and never reasons about which section a nested row really came from.
 */
export function capabilitiesForRow(section: string | null | undefined, groupKey?: string): RowCapabilities | null {
  if (!section) return null;
  const override = groupKey ? GROUP_KIND[section]?.[groupKey] : undefined;
  return capabilitiesFor(override ?? section);
}

