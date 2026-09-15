import { reportTitleOf, reportDateOf, REPORT_KIND_LABEL } from "@pablotech/akesi/report-title";
import { analysisItems } from "./analysis-items";
import { ANALYSIS_NAV } from "./analysis-nav";
import type { Client } from "./types";
import type { Thread } from "./chat-threads";
import type { Tab } from "./nav";
import { SECTION_TAB } from "./permalink";
import { recommendedMarkerGroups } from "./recommended-markers-sidebar-groups";
import { studyAnchor, noteAnchor, reportAnchor, diagnosisAnchor, healthMarkersAnchor } from "./anchor";
import {
  allergySidebarRows,
  familySidebarRows,
} from "./sidebar-leaf-rows";
// W59 — reuses the same {key,label,anchor} derivation the sidebar's group-expand children use
// (src/lib/sidebar-leaf-mappers.ts, new in W58), so a search hit's anchor can never drift from
// what the sidebar scrolls to for the same item. Only `anchor` is reused for questionLeaf/
// explorationItemLeaf below — their mapper `label` is truncated/cell-scoped for the sidebar,
// while search intentionally shows the full question text / the cell's type instead.
import { markerLevelLeaf, markerRatioLeaf, treatmentLeaf, ideaLeaf, explorationItemLeaf, termLeaf } from "./sidebar-leaf-mappers";
import { questionItems } from "./question-items";
import { sortPinnedFirst } from "./pin-sort";
import { flatMarkers } from "./marker-grid";
import { buildMarkerRatios } from "./marker-ratios";
import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
import { collapseByName, bucketOf, todayISODate, formatDose } from "@pablotech/akesi/treatment-bucket";
import { buildHypothesisGroups } from "./treatment-groups";
import { buildStudyPairs } from "./study-pairs";
import { buildNotePairs } from "./note-pairs";
import { buildExplorationRows } from "./exploration-rows";

export interface SearchableLeaf {
  section: string;
  matchTab: Tab;
  anchor: string;
  label: string;
  context?: string;
  searchText: string;
  markerRef?: { name: string; kind: "level" | "ratio" };
  // M103 — which item (by side + true array index) within an exploration cell's items/dueSoon
  // list a leaf represents, so ExplorationCell can scope its render to just that one item.
  explorationRef?: { group?: string; type: string; side: "items" | "dueSoon"; index: number };
  // M103 — which diagnosis (by true array index) within the report a leaf represents, so
  // ReportRow can scope its render to just that diagnosis. Absent index = report-level fallback
  // leaf for a report with zero diagnoses.
  reportRef?: { sourceId: string; index?: number };
  // M103 — which idea (by side + true array index) within a hypothesis topic a leaf represents,
  // so HypothesisTopicCard can scope its render to just that one idea.
  hypothesisRef?: { topic: string; side: "patient" | "ai"; index: number };
  // M91 — the leaf's own prose/body excerpt, when the section carries one; drives search-result
  // previews that render real content (e.g. an Analysis bubble's text) rather than a plain link.
  body?: string;
  // M92 — the thread's first exchange, so ThreadRow can render the actual patient/AI turns instead
  // of the redundant derived title (ChatThreadList's sidebar row already shows that same text).
  chatPair?: { patient?: string; ai?: string };
}

function lastChatPair(turns: Thread["turns"]): { patient?: string; ai?: string } | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "user") {
      return {
        patient: turns[i].text,
        ai: turns[i + 1]?.role === "assistant" ? turns[i + 1].text : undefined,
      };
    }
  }
  return null;
}

export function chatSearchLeaves(threads: Thread[]): SearchableLeaf[] {
  return threads.flatMap((t) => {
    const pair = lastChatPair(t.turns);
    if (!pair) return [];
    return [
      {
        section: "chat",
        matchTab: "chat" as Tab,
        anchor: t.id,
        label: t.title,
        searchText: [t.title, pair.patient, pair.ai].filter(Boolean).join(" "),
        chatPair: pair,
      },
    ];
  });
}

export function glossarySearchLeaves(client: Client): SearchableLeaf[] {
  return (client.finding?.definitions ?? []).map((d) => {
    const { label, anchor } = termLeaf(d);
    return {
      section: "definitions",
      matchTab: SECTION_TAB["definitions"],
      anchor,
      label,
      searchText: [d.term, d.definition].filter(Boolean).join(" "),
    };
  });
}

// W61 — Recommended Markers was unsearchable: it had no leaves builder at all, so a marker LexiTar
// had recommended could not be found by name. One leaf per MARKER (finer than the sidebar's
// per-group rows) because a search is looking for a specific marker, and the per-marker anchor
// already exists; the group rides along as `context`.
export function recommendedMarkerSearchLeaves(client: Client): SearchableLeaf[] {
  return recommendedMarkerGroups(client).flatMap((g) =>
    g.markers.map((m) => ({
      section: "healthMarkers",
      matchTab: SECTION_TAB["healthMarkers"],
      anchor: healthMarkersAnchor(g.group, m.name),
      label: m.name,
      context: g.group,
      searchText: [m.name, m.rationale].filter(Boolean).join(" "),
    })),
  );
}

// W63 — reads question-items.ts, the derivation the body and the sidebar also read. This used to
// walk the whole doctorConversation with no slice and no ordering, so it indexed the groups that
// belong to OTHER sections (report-sections.ts) — hits whose questionAnchor has no DOM target on
// the Questions page, i.e. a result that navigates nowhere.
export function questionsSearchLeaves(client: Client): SearchableLeaf[] {
  return questionItems(client).map((it) => ({
    section: "docInference",
    matchTab: SECTION_TAB["docInference"],
    anchor: it.anchor,
    // The full untruncated question as the label (questionLeaf's own label is cut to 60 for the
    // sidebar's narrow row).
    label: it.question,
    context: it.group,
    searchText: it.question,
  }));
}


// M103 — one leaf per diagnosis (replacing the old whole-report leaf) so a search match scopes
// to just that diagnosis, not every sibling on the same report. Built from the same
// sortPinnedFirst'd per-source diagnosis order ReportRow.svelte's buildReportRows renders, so
// diagnosisAnchor(sourceId, i) here lines up with what ReportRow actually shows at index i.
// Reports with zero diagnoses fall back to one report-level leaf (no reportRef.index).
export function reportSearchLeaves(client: Client): SearchableLeaf[] {
  const leaves: SearchableLeaf[] = [];
  const diseases = client.factors?.diseases ?? [];
  const sources = [...(client.sources ?? [])].sort((a, b) => reportDateOf(b).localeCompare(reportDateOf(a)));
  for (const s of sources) {
    const title = reportTitleOf(s);
    const meta = [title, REPORT_KIND_LABEL[s.kind], reportDateOf(s)].filter(Boolean).join(" ");
    const dx = sortPinnedFirst(diseases.filter((d) => d.sourceId === s.id));
    if (dx.length === 0) {
      leaves.push({
        section: "healthReports",
        matchTab: SECTION_TAB["healthReports"],
        anchor: reportAnchor(s.id),
        label: title,
        searchText: meta,
        reportRef: { sourceId: s.id },
      });
      continue;
    }
    dx.forEach((d, i) => {
      leaves.push({
        section: "healthReports",
        matchTab: SECTION_TAB["healthReports"],
        anchor: diagnosisAnchor(s.id, i),
        label: title,
        searchText: [meta, d.diagnostic, ...(d.icdCodes ?? [])].filter(Boolean).join(" "),
        reportRef: { sourceId: s.id, index: i },
      });
    });
  }
  return leaves;
}

// Mirrors MarkersTab.svelte's own matcher (matchesText / filteredRatios): levels match on
// name/group/source/unit, ratios on name/unit. (W65 — no window to pass: flatMarkers lists the
// record, and the window is a per-chart zoom.)
export function markerSearchLeaves(client: Client): SearchableLeaf[] {
  const leaves: SearchableLeaf[] = [];
  for (const m of flatMarkers(client)) {
    const unit = m.rows[0]?.unit ?? "";
    const { label, anchor } = markerLevelLeaf(m);
    leaves.push({
      section: "markers",
      matchTab: SECTION_TAB["markers"],
      anchor,
      label,
      context: m.group,
      searchText: [m.name, m.group, m.source, unit].filter(Boolean).join(" "),
      markerRef: { name: m.name, kind: "level" },
    });
  }
  for (const rv of buildMarkerRatios(client)) {
    const unit = rv.rows[0]?.unit ?? "";
    const { label, anchor } = markerRatioLeaf(rv);
    leaves.push({
      section: "markers",
      matchTab: SECTION_TAB["markers"],
      anchor,
      label,
      context: unit || undefined,
      searchText: [rv.ratio.name, unit].filter(Boolean).join(" "),
      markerRef: { name: rv.ratio.name, kind: "ratio" },
    });
  }
  return leaves;
}

// Mirrors UnifiedTreatment.svelte's own matcher (matchTreatment): collapsed-by-name items,
// bucketed by today, matching on name/dose/kind/bucket. One leaf per collapsed treatment across
// all buckets so a search hit reverse-matches to the same collapsed name UnifiedTreatment's own
// pendingAnchor effect looks up (treatmentAnchor(t.name) on the COLLAPSED item).
export function treatmentSearchLeaves(client: Client): SearchableLeaf[] {
  const today = todayISODate();
  return collapseByName(treatmentsOf(client)).map((t) => {
    const bucket = bucketOf(t, today);
    const { label, anchor } = treatmentLeaf(t);
    return {
      section: "treatment",
      matchTab: SECTION_TAB["treatment"],
      anchor,
      label,
      context: [bucket, formatDose(t)].filter(Boolean).join(" · "),
      // Ingredient names too: a formulated supplement is far more likely to be looked up by what is
      // in it ("selenium") than by its brand name ("Thyroid Support").
      searchText: [t.name, formatDose(t), t.kind, bucket, t.description, ...(t.ingredients ?? []).map((i) => i.name)]
        .filter(Boolean)
        .join(" "),
    };
  });
}

// Mirrors Study.svelte's own read-only pairing (buildStudyPairs): one leaf per patient/AI-result
// pair, label-matched exactly like Study.svelte's own resolver.
export function studySearchLeaves(client: Client): SearchableLeaf[] {
  return buildStudyPairs(client).map((p) => ({
    section: "study",
    matchTab: SECTION_TAB["study"],
    anchor: studyAnchor(p.label),
    label: p.label,
    context: p.group,
    searchText: [p.label, p.detail, p.result].filter(Boolean).join(" "),
  }));
}

// M92 Phase 8 — mirrors studySearchLeaves above, but id-matched (buildNotePairs) rather than
// label-matched: a note has no short hand-picked focus like Study's. Supersedes the old plain
// noteSidebarRows-based leaves (label/searchText only, no AI result) now that Notes is a real
// AI-paired leaf — a search match now also covers what the AI found, not just the jotted text.
export function noteSearchLeaves(client: Client): SearchableLeaf[] {
  return buildNotePairs(client).map((p) => ({
    section: "notes",
    matchTab: SECTION_TAB["notes"],
    anchor: noteAnchor(p.id),
    label: p.text.trim() ? (p.text.length > 60 ? p.text.slice(0, 60) + "…" : p.text) : "Untitled note",
    context: p.group,
    searchText: [p.text, p.result].filter(Boolean).join(" "),
  }));
}

// M103 — one leaf per patient/ai idea (replacing the old whole-topic leaf) so a search match
// scopes to just that idea, not every sibling in the same topic. Built from buildHypothesisGroups
// (not the raw resolveTreatmentGroups), so ideaAnchor(topic, side, index) here lines up with what
// HypothesisTopicCard actually renders at that index — mirrors reportSearchLeaves/
// explorationSearchLeaves's identical precedent.
export function hypothesisSearchLeaves(client: Client): SearchableLeaf[] {
  const leaves: SearchableLeaf[] = [];
  for (const g of buildHypothesisGroups(client) ?? []) {
    g.patient.forEach((p, index) => {
      const { label, anchor } = ideaLeaf(g.topic, "patient", index, p.label);
      leaves.push({
        section: "futureTreatment",
        matchTab: SECTION_TAB["futureTreatment"],
        anchor,
        label,
        context: g.topic,
        searchText: [g.topic, g.system, p.label, p.purpose].filter(Boolean).join(" "),
        hypothesisRef: { topic: g.topic, side: "patient", index },
      });
    });
    g.ai.forEach((a, index) => {
      const { label, anchor } = ideaLeaf(g.topic, "ai", index, a.intervention);
      leaves.push({
        section: "futureTreatment",
        matchTab: SECTION_TAB["futureTreatment"],
        anchor,
        label,
        context: g.topic,
        searchText: [g.topic, g.system, a.intervention, a.purpose].filter(Boolean).join(" "),
        hypothesisRef: { topic: g.topic, side: "ai", index },
      });
    });
  }
  return leaves;
}

// M103 Phase 6 — one leaf per item in a cell's items[]/dueSoon[] (built from buildExplorationRows,
// not the raw unsorted client.finding.dataRequisition, so indices line up with what
// ExplorationCell actually renders at that index), searchText scoped to that single item plus the
// cell's own type/group, so a search hit scopes ExplorationCell's preview to just that one item.
export function explorationSearchLeaves(client: Client): SearchableLeaf[] {
  const leaves: SearchableLeaf[] = [];
  for (const r of buildExplorationRows(client)) {
    const push = (side: "items" | "dueSoon", list: string[]) => {
      list.forEach((item, index) => {
        // Label stays r.type, the cell's own type (explorationItemLeaf's label is the item text,
        // for the sidebar's per-item row) — only anchor is reused here.
        const { anchor } = explorationItemLeaf(r.group, r.type, side, index, item);
        leaves.push({
          section: "exploration",
          matchTab: SECTION_TAB["exploration"],
          anchor,
          label: r.type,
          context: r.group,
          searchText: [r.type, r.group, item].filter(Boolean).join(" "),
          explorationRef: { group: r.group, type: r.type, side, index },
        });
      });
    };
    push("items", r.items);
    push("dueSoon", r.dueSoon);
  }
  return leaves;
}

// Mirrors each of Analysis.svelte's 6 children's own allRows derivation, at per-bubble
// granularity (not per-block-title) so a search hit lands on the exact bubble, matching how
// markerSearchLeaves/treatmentSearchLeaves mirror their own source components.
export function analysisSearchLeaves(client: Client): SearchableLeaf[] {
  const matchTab = SECTION_TAB["analysis"];
  const blockLabel = new Map(ANALYSIS_NAV.map((n) => [n.key, n.label] as const));
  // W62 — was ~107 lines re-deriving all six Analysis blocks by hand, and it had already drifted:
  // the same item was "Plan assessment"/"System"/"Final thoughts" here and "On Treatment"/"System
  // Analysis"/"Final Thoughts" in the app. analysis-items.ts is the one derivation the body and the
  // sidebar already share; search reads it too now, so a search hit and its cell cannot disagree.
  // Every anchor is unchanged (both sides call the same analysisAnchor), so permalinks still land.
  return analysisItems(client).map((it) => ({
    section: "analysis",
    matchTab,
    anchor: it.anchor,
    label: it.label,
    context: blockLabel.get(it.section) ?? it.section,
    searchText: `${it.label} ${it.text}`,
    body: it.text,
  }));
}

export function buildSearchIndex(client: Client | null, threads: Thread[]): SearchableLeaf[] {
  if (!client) return [];
  const leaves: SearchableLeaf[] = [];
  leaves.push(...reportSearchLeaves(client));
  for (const row of allergySidebarRows(client)) {
    leaves.push({
      section: "allergies",
      matchTab: SECTION_TAB["allergies"],
      anchor: row.anchor,
      label: row.label,
      searchText: [row.label, row.searchText].filter(Boolean).join(" "),
    });
  }
  for (const row of familySidebarRows(client)) {
    leaves.push({
      section: "familyHistory",
      matchTab: SECTION_TAB["familyHistory"],
      anchor: row.anchor,
      label: row.label,
      searchText: [row.label, row.searchText].filter(Boolean).join(" "),
    });
  }
  leaves.push(...glossarySearchLeaves(client));
  leaves.push(...questionsSearchLeaves(client));
  leaves.push(...recommendedMarkerSearchLeaves(client));
  leaves.push(...markerSearchLeaves(client));
  leaves.push(...treatmentSearchLeaves(client));
  leaves.push(...studySearchLeaves(client));
  leaves.push(...noteSearchLeaves(client));
  leaves.push(...hypothesisSearchLeaves(client));
  leaves.push(...explorationSearchLeaves(client));
  leaves.push(...analysisSearchLeaves(client));
  leaves.push(...chatSearchLeaves(threads));
  return leaves;
}
