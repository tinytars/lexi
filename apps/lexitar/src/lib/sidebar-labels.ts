// Shared sidebar label constants.
//
// A PLAIN .ts module on purpose. SidebarGroupRow's type lives in SidebarGroupList.svelte and is
// imported with `import type`, which erases at runtime — but a VALUE imported from a .svelte file is
// a real runtime dependency, and pulling a Svelte component into treatment-bucket.ts and friends
// broke every Node-side consumer of them at once (22 unit test files, and the CLI would have
// followed). Values that pure modules need live here instead.

/**
 * The leading catch-all row every grouped section shows: everything, unfiltered.
 *
 * One constant because this was six separate literals reading "Ungrouped" while Treatment's
 * equivalent row already read "All" — two words for one idea, and a rename that would otherwise have
 * to land in six places to be complete. The row KEY stays "ungrouped": it is the fallback written to
 * hd_last_group_v1 and compared by name in MarkersTab/QuestionsForDr/Glossary, so renaming it would
 * strand every saved nav state.
 */
export const ALL_GROUP_LABEL = "All";

// The All row's KEY, as opposed to its label. Persisted in hd_last_group_v1 and string-compared by
// the bodies that narrow on it (MarkersTab, QuestionsForDr, Glossary, FutureTreatment), which is why
// it stays "ungrouped" even though the label is now "All" — renaming it strands saved nav state.
export const ALL_GROUP_KEY = "ungrouped";
