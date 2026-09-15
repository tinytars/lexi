// W38 — deterministic, content-derived anchor ids for permalinking. Every addressable
// component gets an element id derived from how the UI already keys it (report id, marker
// name, treatment name, …), so "full depth" addressability needs no vault data migration and
// no Finding regen. The tradeoff, like a GitHub line anchor, is that renaming the underlying
// text moves the anchor — acceptable, and it avoids persisting ids into committed PHI.

// The shared slugify (generalizes MarkersTab's chartIdFor): lowercase, non-alphanumerics
// collapsed to single dashes, trimmed. Stable for a given input.
// M102 — "%" spelled out as "pct" before stripping, not just dropped: DEXA marker pairs like
// "Android Fat"/"Android % Fat" otherwise collapse to the same anchor (a real duplicate-id bug
// surfaced when M102 Phase 2 reordered Markers' Ungrouped view).
export function slug(text: string): string {
  return text.toLowerCase().replace(/%/g, "pct").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Per-entity anchor ids. Marker/watchlist reuse the "chart-…" shape MarkersTab already emits
// so the existing chart elements are the scroll targets.
export const reportAnchor = (id: string) => `report-${id}`;
// M66 P4 — a single diagnosis row within a report, composed under the report's own anchor prefix
// so a permalink to one diagnosis still groups with the report it belongs to.
export const diagnosisAnchor = (reportId: string, index: number) => `${reportAnchor(reportId)}-dx-${index}`;
export const markerAnchor = (name: string) => `chart-${slug(name)}`;
export const watchAnchor = (name: string) => `chart-${slug("watch-" + name)}`;
export const ratioAnchor = (name: string) => `chart-${slug("ratio-" + name)}`;
export const treatmentAnchor = (name: string) => `rx-${slug(name)}`;
export const conditionAnchor = (text: string) => `cond-${slug(text)}`;
export const correlationAnchor = (date: string, event: string) => `corr-${slug(date + " " + event)}`;
export const decisionAnchor = (intervention: string) => `dec-${slug(intervention)}`;
export const studyAnchor = (focus: string) => `study-${slug(focus)}`;
// M80 — Exploration's (modality × system) cells; composed under the owning system so a permalink to
// one test-suggestion cell still groups with its risk area, mirroring ideaAnchor's shape.
export const explorationAnchor = (group: string | undefined, type: string) =>
  `explore-${slug((group ?? "uncategorized") + " " + type)}`;
// M103 — a single item within an exploration cell's items/dueSoon list, composed under the
// cell's own explorationAnchor prefix, mirroring ideaAnchor's shape.
export const explorationItemAnchor = (group: string | undefined, type: string, side: "items" | "dueSoon", index: number) =>
  `${explorationAnchor(group, type)}-${side}-${index}`;
export const futureAnchor = (topic: string) => `spec-${slug(topic)}`;
// M66 P4 — a single hypothesis idea's leaf anchor, composed under its topic's futureAnchor prefix
// so a permalink to one idea still groups with the section it belongs to.
export const ideaAnchor = (topic: string, side: "patient" | "ai", index: number) =>
  `${futureAnchor(topic)}-${side}-${index}`;
export const threadAnchor = (threadId: string) => threadId;
// M78 — Notes had no per-row anchor before the sidebar gained a leaf list to scroll to one.
export const noteAnchor = (id: string) => `note-${id}`;
// M85 — Glossary terms have no id (types.ts definitions[]); slug the term itself.
export const termAnchor = (term: string) => `term-${slug(term)}`;
// M85 — Questions for Dr. questions have no id (types.ts doctorConversation[].questions is
// string[]); composite-keyed under the owning group, mirroring ideaAnchor's shape.
export const questionAnchor = (group: string, index: number) => `question-${slug(group)}-${index}`;
// M85 — Analysis bubbles are content-derived (blockKey+label) rather than index-derived, since
// every row already carries a natural label/topic string, unlike ideaAnchor/questionAnchor's
// positional items.
export const analysisAnchor = (blockKey: string, label: string) => `analysis-${slug(blockKey)}-${slug(label)}`;
export const messageAnchor = (threadId: string, index: number) => `${threadId}-turn-${index}`;
// M97 §F — a single recommended-marker row within finding.healthMarkers.recommended, composed
// under its owning body-system group, mirroring explorationAnchor's group+item shape.
export const healthMarkersAnchor = (group: string, name: string) => `hm-${slug(group)}-${slug(name)}`;
// W61 — the group's own anchor. A Recommended Markers CELL is one body-system group (the sidebar
// lists one row per group, matching the cells), so the card needs an id of its own distinct from
// any single marker's.
export const healthMarkersGroupAnchor = (group: string) => `hm-${slug(group)}`;

/**
 * Does `pending` name this cell, or something INSIDE it?
 *
 * A deep link often points at an item-level anchor (`explorationItemAnchor`, a diagnosis, a dose
 * row) that never strictly equals the cell-level anchor its section switches groups on — the
 * item's id is the cell's plus a `-suffix`. Every section that reverse-matches a pendingAnchor
 * back to its owning group needs the same test, and W64 found two of the five doing it with `===`
 * alone (MarkersTab, UnifiedTreatment), so a composite anchor never matched there and the deep
 * link landed on whatever group happened to be active.
 */
export function anchorMatches(pending: string, anchor: string): boolean {
  return pending === anchor || pending.startsWith(anchor + "-");
}

/**
 * A list of row anchors, each `conditionAnchor(text)`, with the row's own index appended ONLY where
 * an earlier row already claimed that slug.
 *
 * Six copies of this loop existed — Allergies/Family's `rowAnchor`, AllergyRow/FamilyRow's inlined
 * versions, sidebar-leaf-rows' `collisionSafeAnchor`, reference-resolver's `dedupedAnchor` — and the
 * comments blessing the duplication had gone stale in three different ways: two cited components
 * that no longer exist, one cited a `Personalization.svelte` helper that was removed. They must
 * agree, because the sidebar row, the body cell, the search preview and the permalink RESOLVER all
 * have to compute the same id for the same row.
 *
 * Takes the list in the order it is RENDERED: the suffix is positional, so a caller that sorts
 * (pinned-first, say) must pass the sorted list, not the underlying array.
 */
export function rowAnchors(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  return texts.map((text, i) => {
    const base = conditionAnchor(text);
    if (!seen.has(base)) { seen.add(base); return base; }
    return `${base}-${i}`;
  });
}

/**
 * The item that OWNS `pending` — its own anchor, or the cell it is nested in.
 *
 * Exact matches are tried across the whole list BEFORE any prefix match, because the `-` separator
 * is not enough on its own: `markerAnchor("ApoB Ratio")` is `apob-ratio`, which is a legitimate
 * prefix-child of `markerAnchor("ApoB")` = `apob`. A single pass would hand "ApoB" the link meant
 * for "ApoB Ratio" whenever it came first. Every reverse-match goes through here so none of the
 * five sections has to remember that.
 */
export function findByAnchor<T>(items: readonly T[], pending: string, anchorOf: (item: T) => string): T | undefined {
  return items.find((i) => anchorOf(i) === pending) ?? items.find((i) => pending.startsWith(anchorOf(i) + "-"));
}

// Scroll an element into view and briefly ring it so a resolved permalink makes its target
// obvious. No-op when the element is absent (target not present for this client / not visible)
// or off the DOM (SSR/tests). The class is removed after the animation window.
const FLASH_MS = 1200;
export function flashAnchor(id: string, tries = 8): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(id);
  if (!el) {
    // Target may still be mounting (lazy section, async-loaded chat thread) — retry briefly.
    if (tries > 0) setTimeout(() => flashAnchor(id, tries - 1), 150);
    return;
  }
  el.scrollIntoView({ behavior: "auto", block: "center" });
  el.classList.add("permalink-flash");
  setTimeout(() => el.classList.remove("permalink-flash"), FLASH_MS);
}
