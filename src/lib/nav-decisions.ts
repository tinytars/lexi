// Pure navigation/grouping decisions extracted from App.svelte (W79 phase 3a). Kept separate from
// nav-controller.ts because these take plain arguments and close over nothing — no component state,
// no Svelte runes — so they're unit-testable without any component or effect machinery.

/** A handful of report sections render as a Notes sub-tab rather than their own top-level tab. */
export const NESTED_IN_NOTES = new Set(["docInference", "healthMarkers", "definitions"]);

/** Sections a pending anchor is allowed to target — the rest ignore `pl.anchor`/`patch.anchor`. */
export const ANCHOR_ELIGIBLE_SECTIONS = new Set(["markers", "treatment", "futureTreatment", "exploration"]);

export function resolveNestedSection(key: string | null): [string | null, string | null] {
  return key && NESTED_IN_NOTES.has(key) ? ["notes", key] : [key, null];
}

export type HashSyncMode = "push" | "replace";

export interface HashSyncResult {
  mode: HashSyncMode;
  nextLastCoarse: string;
}

/**
 * Decides whether a nav change should push a new history entry or just replace the current one.
 * `coarse` (client+tab) changing means "the user went somewhere new" -> push; anything finer (same
 * client+tab, different section/anchor) replaces so back/forward doesn't spam per-section.
 */
export function decideHashSync(
  current: { selectedClientId: string | null; activeTab: string },
  lastCoarse: string,
): HashSyncResult {
  const coarse = (current.selectedClientId ?? "") + "|" + current.activeTab;
  return coarse !== lastCoarse ? { mode: "push", nextLastCoarse: coarse } : { mode: "replace", nextLastCoarse: lastCoarse };
}

/** Sections that have a sidebar group selector at all — the rest never touch activeGroup. */
export const GROUP_SECTIONS = new Set([
  "markers", "treatment", "futureTreatment", "exploration",
  "healthReports", "notes", "study", "docInference", "definitions",
]);

/** Sections whose "ungrouped" default is the first system-ordered group rather than ALL_GROUP_KEY. */
export const FIRST_SYSTEM_DEFAULT_SECTIONS = new Set(["futureTreatment", "exploration"]);

// Sections whose flat "ungrouped" row no longer exists, so they name their own default instead.
// Treatment's "All" (key `medicine`, its per-drug history view) replaced the old Ungrouped row.
export const SECTION_DEFAULT_GROUP: Record<string, string> = { treatment: "medicine" };

/**
 * Which group a section should default to when the visitor has no remembered choice. `remembered`
 * and `firstSystemDefault` (the caller's `systemOrder(currentClient)[0] ?? null`) are passed in
 * pre-computed since both require reading localStorage / the current client — this function is the
 * pure decision over their results.
 */
export function resolveDefaultGroup(
  section: string,
  remembered: string | null,
  firstSystemDefault: string | null,
  allGroupKey: string,
): string | null {
  if (remembered) return remembered;
  if (FIRST_SYSTEM_DEFAULT_SECTIONS.has(section)) return firstSystemDefault;
  return SECTION_DEFAULT_GROUP[section] ?? allGroupKey;
}
