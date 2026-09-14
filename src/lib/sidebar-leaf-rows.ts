// M78 — row-builders for SidebarLeafList.svelte. Each mirrors the exact anchor logic its body
// component already uses (Allergies.svelte/Family.svelte's collision-suffixed conditionAnchor,
// Study.svelte's studyAnchor, Notes.svelte's noteAnchor) so a sidebar click resolves to the same
// DOM id the body renders — no new anchor scheme, just read the existing one from the sidebar.
import type { Client } from "./types";
import { rowAnchors, studyAnchor, noteAnchor, reportAnchor } from "./anchor";
import { sortPinnedFirst } from "./pin-sort";
import type { SidebarLeafRow, SidebarGroupRow } from "@tinytars/frame/sidebar-rows";
import { ALL_GROUP_LABEL, ALL_GROUP_KEY } from "./sidebar-labels";
import { reportTitleOf, reportDateOf, REPORT_KIND_LABEL } from "@pablotech/akesi-pil/report-title";
import { questionsSidebarGroups } from "./questions-sidebar-groups";
import { glossarySidebarGroups } from "./glossary-sidebar-groups";
import { recommendedMarkersSidebarGroups } from "./recommended-markers-sidebar-groups";


export function allergySidebarRows(client: Client): SidebarLeafRow[] {
  const list = sortPinnedFirst(client.factors?.allergies ?? []);
  const anchors = rowAnchors(list.map((a) => a.allergen));
  return list.map((a, i) => ({
    key: a.id,
    label: a.allergen || "Untitled",
    anchor: anchors[i],
    pinned: a.pinned,
    // W69 — same gap as familySidebarRows below, and the same fix. The LABEL is the allergen because
    // that is what the sidebar shows and what the anchor is built from, but a patient often remembers
    // the reaction and not the drug ("the one that gave me hives"). Without this the index carried
    // only "Penicillin". Search-only; the row renders unchanged.
    searchText: a.reaction,
  }));
}

export function familySidebarRows(client: Client): SidebarLeafRow[] {
  const list = sortPinnedFirst(client.factors?.familyHistory ?? []);
  const anchors = rowAnchors(list.map((f) => f.relation));
  return list.map((f, i) => ({
    key: f.id,
    label: f.relation || "Untitled",
    anchor: anchors[i],
    pinned: f.pinned,
    // W69 — the LABEL is the relation, because that is what the sidebar shows and what the anchor is
    // built from. But the condition is the half worth searching for: "diabetes" is what a patient
    // types, "Mother" is not. Without this the index carried only "Mother", so a family history of a
    // condition was unfindable — while a NOTE mentioning the same condition was found immediately,
    // since noteSidebarRows has always passed searchText. Search-only; the row renders unchanged.
    searchText: f.condition,
  }));
}

export function noteSidebarRows(client: Client): SidebarLeafRow[] {
  const list = sortPinnedFirst(client.factors?.noteEntries ?? []);
  return list.map((n) => ({
    key: n.id,
    label: n.text.trim() ? (n.text.length > 60 ? n.text.slice(0, 60) + "…" : n.text) : "Untitled note",
    anchor: noteAnchor(n.id),
    pinned: n.pinned,
    searchText: n.text,
  }));
}


// Scoped to `client.sources` (real reports with real anchors) — pending uploads (no diagnoses yet)
// and self-reported diseases (no anchor today) are edge cases that stay body-only, not sidebar-navigable.
export function reportSidebarRows(client: Client): SidebarLeafRow[] {
  const diseases = client.factors?.diseases ?? [];
  const sources = [...(client.sources ?? [])].sort((a, b) => reportDateOf(b).localeCompare(reportDateOf(a)));
  return sortPinnedFirst(sources).map((s) => {
    const dx = diseases.filter((d) => d.sourceId === s.id);
    const searchText = [reportTitleOf(s), REPORT_KIND_LABEL[s.kind], reportDateOf(s), ...dx.map((d) => d.diagnostic), ...dx.flatMap((d) => d.icdCodes ?? [])].join(" ");
    return { key: s.id, label: reportTitleOf(s), anchor: reportAnchor(s.id), searchText, pinned: s.pinned };
  });
}

// Scoped to the patient-authored rows (entries) — an AI-answered topic with no patient input yet
// has no row here, same judgment call as Reports' sidebar list excluding pending uploads/
// self-reported diseases (edge cases, not the primary navigable content).
export function studySidebarRows(client: Client): SidebarLeafRow[] {
  const rows: SidebarLeafRow[] = [];
  for (const e of sortPinnedFirst(client.study?.entries ?? [])) {
    rows.push({ key: e.id, label: e.focus || "Untitled", anchor: studyAnchor(e.focus), pinned: e.pinned });
  }
  return rows;
}

// W58 — Notes/Study are single-group-by-design (owner decision, M97 §E): the sole "Ungrouped"
// row's own children ARE the section's full item list, expanded by default so this reads
// identically to the pre-W58 always-visible flat list, just now collapsible too.
// Notes now hosts Questions and Glossary as sibling group rows below its own All row — they were
// small top-level sections competing with Notes rather than sitting under it. Their children come
// from their OWN builders rather than being rebuilt here, so each keeps its grouping logic and a fix
// to either lands in one place.
export function notesSidebarGroups(client: Client): SidebarGroupRow[] {
  const children = noteSidebarRows(client);
  // The FIRST row only — each builder's leading All row already holds every item, and the per-topic
  // / per-system rows that follow repeat those same leaves. Flat-mapping every row therefore listed
  // each item twice and Svelte threw each_key_duplicate, which took the whole sidebar group list
  // down rather than just duplicating a row.
  const questions = questionsSidebarGroups(client)[0]?.children ?? [];
  const glossary = glossarySidebarGroups(client)[0]?.children ?? [];
  const recMarkers = recommendedMarkersSidebarGroups(client)[0]?.children ?? [];
  const rows: SidebarGroupRow[] = [
    { key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: children.length, children, defaultExpanded: true },
  ];
  // Collapsed by default: All's own items already fill the pane, and three expanded lists pushed
  // Questions and Glossary below the fold entirely.
  if (questions.length) rows.push({ key: "docInference", label: "Questions", count: questions.length, children: questions });
  if (recMarkers.length) rows.push({ key: "healthMarkers", label: "Markers", count: recMarkers.length, children: recMarkers });
  if (glossary.length) rows.push({ key: "definitions", label: "Glossary", count: glossary.length, children: glossary });
  return rows;
}

export function studySidebarGroups(client: Client): SidebarGroupRow[] {
  const children = studySidebarRows(client);
  return [{ key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: children.length, children, defaultExpanded: true }];
}
