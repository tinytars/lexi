// Every Analysis item, derived ONCE.
//
// Analysis renders six blocks, four of which are already lists of individual LexiTar turns
// (Progression is Latest/Recent/Overall; System, Pattern and Synthesis are per topic). Each of
// those derivations used to live only inside its own component, so the sidebar could not list the
// items without recomputing them — the same drift `analysis-nav.ts` was created to prevent for the
// section headings. This is the single source: the components render from it and the sidebar lists
// from it, so a block's items and its sidebar rows cannot disagree.
import type { Client } from "./types";
import { analysisAnchor } from "./anchor";
import { ANALYSIS_NAV } from "./analysis-nav";
import { ALL_GROUP_KEY, ALL_GROUP_LABEL } from "./sidebar-labels";
import type { SidebarGroupRow, SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
import { isPinnedItem, itemRecordId } from "@pablotech/akesi-pil/item-registry";
import { sortPinnedFirst } from "./pin-sort";

export interface AnalysisItem {
  /** The ANALYSIS_NAV key of the block this item belongs to. */
  section: string;
  label: string;
  text: string;
  anchor: string;
}

const SECTION_LABEL = new Map(ANALYSIS_NAV.map((r) => [r.key, r.label] as const));

/**
 * The registry id for one Analysis item — `section/label`, NOT the passage text: the body is a
 * paragraph the next Finding rewrites in full, while "system/Cardiovascular Risk" names the same
 * turn across every regeneration. Exported so the sidebar row and the body cell derive the same id
 * from the same place; two copies of this expression would be two ways to disagree about which
 * item is pinned.
 */
export function analysisItemId(it: AnalysisItem): string {
  return itemRecordId("analysis", `${it.section}/${it.label}`);
}

/** A block with a single item names that item after the block itself. */
function sectionLabel(section: string): string {
  return SECTION_LABEL.get(section) ?? section;
}

function item(section: string, key: string, label: string, text: string | undefined): AnalysisItem[] {
  return text?.trim() ? [{ section, label, text, anchor: analysisAnchor(section, key) }] : [];
}

export function progressionItems(client: Client): AnalysisItem[] {
  const p = client.finding?.progression;
  if (!p) return [];
  return [
    ...item("progression", "Latest", "Latest", p.latest),
    ...item("progression", "Recent", "Recent", p.recent),
    ...item("progression", "Overall", "Overall", p.overall),
  ];
}

export function onTreatmentItems(client: Client): AnalysisItem[] {
  // finding.planAssessment — the AI's holistic read of the plan (OnTreatment.svelte).
  return item("ontreatment", "assessment", sectionLabel("ontreatment"), client.finding?.planAssessment);
}

export function systemItems(client: Client): AnalysisItem[] {
  // `unknown` so the legacy string-shape branch still type-checks (the current type says disease is
  // always an array, but older vaults could carry a plain string).
  const d: unknown = client.finding?.disease;
  if (Array.isArray(d)) {
    return d
      .filter((x) => x?.finding?.trim())
      .flatMap((x, i) => item("system", x.group || String(i), x.group || sectionLabel("system"), x.finding));
  }
  if (typeof d === "string" && d.trim()) return item("system", "", sectionLabel("system"), d);
  return [];
}

export function patternItems(client: Client): AnalysisItem[] {
  const pa = client.finding?.patternAntipattern;
  if (!pa) return [];
  return [
    ...item("pattern", "Patient pattern", "Patient pattern", pa.pattern),
    ...item("pattern", "Patient anti-pattern", "Patient anti-pattern", pa.antipattern),
  ];
}

export function synthesisItems(client: Client): AnalysisItem[] {
  const cs = client.finding?.clinicalSynthesis;
  if (!cs) return [];
  return [
    ...item("synthesis", "Working against the patient", "Working against the patient", cs.adverse),
    ...item("synthesis", "Working in the patient's favor", "Working in the patient's favor", cs.favorable),
    ...item("synthesis", "Biological-age read", "Biological-age read", cs.conditioning),
  ];
}

export function finalThoughtsItems(client: Client): AnalysisItem[] {
  return item("final", "thoughts", sectionLabel("final"), client.finding?.finalThoughts);
}

const BY_SECTION: Record<string, (client: Client) => AnalysisItem[]> = {
  progression: progressionItems,
  ontreatment: onTreatmentItems,
  system: systemItems,
  pattern: patternItems,
  synthesis: synthesisItems,
  final: finalThoughtsItems,
};

/** Every item, in ANALYSIS_NAV order — the order the page renders them in. */
export function analysisItems(client: Client): AnalysisItem[] {
  return ANALYSIS_NAV.flatMap((nav) => BY_SECTION[nav.key]?.(client) ?? []);
}

export function analysisItemsFor(client: Client, section: string): AnalysisItem[] {
  return BY_SECTION[section]?.(client) ?? [];
}

/**
 * Analysis's sidebar rows: an All row over every item, then one row per block.
 *
 * Unlike Markers/Hypothesis/Exploration, Analysis's body renders every block at once and a row
 * click is a scroll-to, not a view switch (see analysis-nav.ts) — so these groups exist to LIST the
 * items, not to filter the page.
 */
export function analysisSidebarGroups(client: Client): SidebarGroupRow[] {
  // W62 — the record key is `section/label`, NOT the passage text: an analysis item's body is a
  // paragraph the next Finding rewrites in full, while "system/Cardiovascular Risk" or
  // "progression/Latest" names the same turn across every regeneration. Pinning one says "keep
  // looking at this", which survives the words changing — the whole point of the pin.
  const leafOf = (it: AnalysisItem): SidebarLeafRow => ({
    key: it.anchor,
    label: it.label,
    anchor: it.anchor,
    itemId: analysisItemId(it),
    pinned: isPinnedItem(client, "analysis", `${it.section}/${it.label}`),
  });
  const sections = ANALYSIS_NAV.map((nav) => {
    const children = sortPinnedFirst(analysisItemsFor(client, nav.key).map(leafOf));
    return { key: nav.key, label: nav.label, count: children.length, children };
  });
  const all = sortPinnedFirst(analysisItems(client).map(leafOf));
  return [{ key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: all.length, children: all }, ...sections];
}
