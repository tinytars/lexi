// What a section renders for the current sidebar group selection — ONE rule, shared by every
// section, because they had each invented their own and two of them got it wrong.
//
// The bug this exists to kill: two sections resolved the active group as
// `activeGroup && groups.some(g => g.key === activeGroup) ? activeGroup : groups[0].key`.
// The sidebar emits a row per group even at count 0, so selecting an EMPTY group fell through
// that ternary and rendered the FIRST group's cells instead — the section looked like it had
// ignored the click, or worse, like those cells belonged to the group you picked. A third section
// was worse still: it took no group at all and only ever scrolled.
//
// The rule: All (or nothing selected) shows everything; a named group shows exactly its own items,
// even when that is none. Rendering nothing is a correct answer, and the caller shows an empty
// state saying so. Never substitute another group's content.
// allGroupKey is caller-supplied rather than a frame-owned constant: which key means "all groups"
// is a per-app storage convention, not something generic UI logic should hardcode.
export function isAllGroup(activeGroup: string | null | undefined, allGroupKey: string): boolean {
  return !activeGroup || activeGroup === allGroupKey;
}

export function filterByGroup<T>(
  items: T[],
  activeGroup: string | null | undefined,
  groupOf: (item: T) => string | undefined | null,
  allGroupKey: string,
): T[] {
  if (isAllGroup(activeGroup, allGroupKey)) return items;
  return items.filter((i) => groupOf(i) === activeGroup);
}

/**
 * The same rule as filterByGroup, one level down: a selected CHILD row narrows its section to that
 * one item. `null` (nothing selected) shows everything, exactly as an All group does.
 *
 * Some sections need this because their child rows ARE their cells one-for-one, so clicking one
 * and having the page merely scroll reads as the click being ignored, the same complaint that
 * produced filterByGroup. Sections whose children are not their cells (a note among many notes)
 * pass no activeLeaf and are unaffected.
 */
export function filterByLeaf<T>(
  items: T[],
  activeLeaf: string | null | undefined,
  keyOf: (item: T) => string | undefined,
): T[] {
  if (!activeLeaf) return items;
  const hit = items.filter((i) => keyOf(i) === activeLeaf);
  // A leaf key that matches nothing here (a stale selection from another section, or a row whose
  // section does not filter) shows everything rather than an empty page — the same defensive
  // fallback a caller's own resolvedGroup logic would want.
  return hit.length ? hit : items;
}

/**
 * Which group a section RENDERS, as opposed to which items it then shows.
 *
 * The selected key wins whenever it names a row the sidebar actually emits — including a row with
 * nothing in it. Falling back from an empty-but-real row is the substitution filterByGroup exists
 * to prevent, one level up: a caller's own group ladder did exactly that for a group emitted at
 * count 0, dropping the user on the whole unfiltered list. `fallback` is for keys that name NO
 * row: nothing selected yet, or one left over from another section or a regen that dropped a
 * group.
 */
export function resolveGroup(
  activeGroup: string | null | undefined,
  keys: Iterable<string>,
  fallback: () => string | null,
): string | null {
  if (activeGroup && new Set(keys).has(activeGroup)) return activeGroup;
  return fallback();
}
