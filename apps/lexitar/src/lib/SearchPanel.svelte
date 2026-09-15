<script lang="ts">
  import type { SearchableLeaf } from "./search-index";
  import { sectionLabel } from "./permalink";
  import type { UnitSystem } from "@pablotech/akesi/unit-systems";
  import type { Client } from "./types";
  import MarkerChart from "./MarkerChart.svelte";
  import { flatMarkers } from "./marker-grid";
  import { buildMarkerRatios } from "./marker-ratios";
  import { deltaForSeries } from "@pablotech/akesi/marker-deltas";
  import { currentZoneStatus } from "@pablotech/akesi/ranges";
  import ExplorationCell from "./ExplorationCell.svelte";
  import { buildExplorationRows } from "./exploration-rows";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import TreatmentRow, { buildTreatmentRows } from "./TreatmentRow.svelte";
  import StudyRow from "./StudyRow.svelte";
  import { buildStudyPairs } from "./study-pairs";
  import { buildNotePairs } from "./note-pairs";
  import NoteRow from "./NoteRow.svelte";
  import ReportCell, { buildReportRows } from "./ReportCell.svelte";
  import { openOnly } from "@tinytars/frame/LeafActionMenu.svelte";
  import ThreadRow from "./ThreadRow.svelte";
  import AllergyRow, { buildAllergyRows } from "./AllergyRow.svelte";
  import FamilyRow, { buildFamilyRows } from "./FamilyRow.svelte";
  import GlossaryTermPreview from "./GlossaryTermPreview.svelte";
  import QuestionPreview from "./QuestionPreview.svelte";
  import AnalysisItemCard from "./AnalysisItemCard.svelte";
  import { analysisItems } from "./analysis-items";
  import HypothesisTopicCard, { buildHypothesisEvalMap } from "./HypothesisTopicCard.svelte";
  import { buildHypothesisGroups } from "./treatment-groups";
  import { treatmentAnchor, studyAnchor, noteAnchor, termAnchor } from "./anchor";
  import type { Permalink } from "./permalink";
  import { cellPin, type PinItem } from "./body-pin";

  // M91 Phase 2 — renamed from SearchResults.svelte; now owns the query input itself (moved out
  // of the sidebar) and the Google-homepage layout transition: a centered box with no results
  // while the query is empty, moving to a top-left box + grouped results once it isn't.
  interface Props {
    query: string;
    results: SearchableLeaf[];
    client: Client | null;
    clientId?: string | null;
    unitSystem: UnitSystem;
    windowYears: number;
    // M104 — bumped by App.svelte every time the Search nav row is clicked, so a re-click while
    // already open still refocuses the input (autofocus only fires on this component's own mount).
    focusToken?: number;
    onStartChat?: (pl: Permalink) => void;
    // W64 / #100 — a search hit is pinnable, like the same item in its own section. This panel used
    // to take no pin handler at all, so none of its previews showed a star even though five of the
    // preview components already accepted one. App.svelte's sidebarTogglePin is exactly this shape.
    onPin?: PinItem;
    onSelect: (leaf: SearchableLeaf) => void;
    onClose: () => void;
  }
  let { query = $bindable(""), results, client, clientId = null, unitSystem, windowYears, focusToken = 0, onStartChat, onPin, onSelect, onClose }: Props = $props();

  let hasQuery = $derived(query.trim().length > 0);
  let inputEl: HTMLInputElement | undefined;

  $effect(() => { void focusToken; inputEl?.focus(); });

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (query.trim().length > 0) query = "";
    else onClose();
  }

  const groups = $derived.by(() => {
    const bySection = new Map<string, SearchableLeaf[]>();
    for (const leaf of results) {
      const list = bySection.get(leaf.section) ?? [];
      list.push(leaf);
      bySection.set(leaf.section, list);
    }
    const order = [...bySection.keys()].sort((a, b) => (a === "chat" ? -1 : b === "chat" ? 1 : 0));
    return order.map((section) => ({ section, label: sectionLabel(section), leaves: bySection.get(section)! }));
  });

  // Markers group: re-derive the one marker's rows/status via the same helpers MarkersTab
  // uses, so a search preview renders an actual MarkerChart instead of a plain text row.
  // Ratios need the ratioClient merge trick MarkersTab.svelte:241 uses — MarkerChart resolves
  // its personalized-range bands from client.personalizedRanges internally (MarkerChart.svelte:92),
  // and a ratio's range never lives there natively.
  function markerChartView(ref: { name: string; kind: "level" | "ratio" }) {
    if (!client) return null;
    if (ref.kind === "level") {
      const m = flatMarkers(client).find((mk) => mk.name === ref.name);
      if (!m) return null;
      return { name: m.name, rows: m.rows, client, status: m.status };
    }
    const rv = buildMarkerRatios(client).find((r) => r.ratio.name === ref.name);
    if (!rv) return null;
    const ratioClient = rv.range
      ? { ...client, personalizedRanges: { ...client.personalizedRanges, [rv.ratio.name]: rv.range } }
      : client;
    return {
      name: rv.ratio.name,
      rows: rv.rows,
      client: ratioClient,
      status: currentZoneStatus(rv.rows[rv.rows.length - 1]?.value ?? null, rv.range),
    };
  }

  function explorationView(leaf: SearchableLeaf) {
    if (!client || !leaf.explorationRef) return null;
    const ref = leaf.explorationRef;
    return buildExplorationRows(client).find((r) => r.group === ref.group && r.type === ref.type) ?? null;
  }

  function treatmentView(leaf: SearchableLeaf) {
    if (!client) return null;
    const { ongoing, planned, past } = buildTreatmentRows(client);
    const row = [...ongoing, ...planned].find((r) => treatmentAnchor(r.name) === leaf.anchor);
    if (row) return { row };
    const pastRow = past.find((r) => treatmentAnchor(r.name) === leaf.anchor);
    return pastRow ? { row: pastRow } : null;
  }

  function studyView(leaf: SearchableLeaf) {
    if (!client) return null;
    return buildStudyPairs(client).find((p) => studyAnchor(p.label) === leaf.anchor) ?? null;
  }

  // W62 — the analysis branch was the LAST preview rendering a bare PersonaBubble; the pass that
  // converted QuestionPreview and GlossaryTermPreview missed it, so an Analysis hit had no card, no
  // anchor and no ★ while the same item in Analysis is a full turn cell. Resolving back to the
  // AnalysisItem (rather than reading leaf.label/body) is what lets AnalysisItemCard compute the
  // item's registry id, so the star in search and the star in the section are the same record.
  function analysisView(leaf: SearchableLeaf) {
    if (!client) return null;
    return analysisItems(client).find((i) => i.anchor === leaf.anchor) ?? null;
  }

  function notesView(leaf: SearchableLeaf) {
    if (!client) return null;
    return buildNotePairs(client).find((p) => noteAnchor(p.id) === leaf.anchor) ?? null;
  }

  function hypothesisView(leaf: SearchableLeaf) {
    if (!client || !leaf.hypothesisRef) return null;
    return (buildHypothesisGroups(client) ?? []).find((g) => g.topic === leaf.hypothesisRef!.topic) ?? null;
  }

  function reportView(leaf: SearchableLeaf) {
    if (!client || !leaf.reportRef) return null;
    return buildReportRows(client).find((r) => r.source.id === leaf.reportRef!.sourceId) ?? null;
  }

  function allergyView(leaf: SearchableLeaf) {
    if (!client) return null;
    return buildAllergyRows(client).find((r) => r.anchor === leaf.anchor) ?? null;
  }

  function familyView(leaf: SearchableLeaf) {
    if (!client) return null;
    return buildFamilyRows(client).find((r) => r.anchor === leaf.anchor) ?? null;
  }

  function glossaryView(leaf: SearchableLeaf) {
    if (!client) return null;
    return client.finding?.definitions?.find((d) => termAnchor(d.term) === leaf.anchor) ?? null;
  }
</script>

<div class="search-panel leaf-section" class:home={!hasQuery}>
  <div class="search-box">
    <!-- svelte-ignore a11y_autofocus -->
    <input bind:this={inputEl} class="search-input" type="search" placeholder="Search across your record…"
           bind:value={query} aria-label="Search" autofocus onkeydown={onKeydown} />
    <DictateButton onResult={(t) => (query = query ? `${query} ${t}` : t)} />
    <button class="search-close" title="Close search" aria-label="Close search" onclick={onClose}>✕</button>
  </div>
  {#if hasQuery}
    <div class="search-results">
      {#if results.length === 0}
        <p class="search-empty">No matches for "{query}".</p>
      {:else}
        {#each groups as g (g.section)}
          <section class="search-group">
            <h3>{g.label}</h3>
            {#each g.leaves as leaf (leaf.section + leaf.anchor)}
              {#if leaf.markerRef}
                {@const view = markerChartView(leaf.markerRef)}
                {#if view}
                  <MarkerChart
                    name={view.name}
                    rows={view.rows}
                    client={view.client}
                    {unitSystem}
                    {windowYears}
                    size="large"
                    status={view.status}
                    delta={deltaForSeries(view.rows)}
                    chartId={leaf.anchor}
                    onToggle={() => onSelect(leaf)}
                  />
                {/if}
              {:else if leaf.section === "exploration"}
                {@const view = explorationView(leaf)}
                {#if view}
                  <ExplorationCell req={view} only={leaf.explorationRef && { side: leaf.explorationRef.side, index: leaf.explorationRef.index }} onOpen={() => onSelect(leaf)} client={client ?? undefined} {onPin} />
                {/if}
              {:else if leaf.section === "treatment"}
                {@const view = treatmentView(leaf)}
                {#if view}
                  <TreatmentRow row={view.row} {clientId} onOpen={() => onSelect(leaf)} />
                {/if}
              {:else if leaf.section === "analysis"}
                {@const view = analysisView(leaf)}
                {#if view}
                  <AnalysisItemCard item={view} client={client!} onOpen={() => onSelect(leaf)} {onPin} />
                {/if}
              {:else if leaf.section === "study"}
                {@const view = studyView(leaf)}
                {#if view}
                  <StudyRow pair={view} onOpen={() => onSelect(leaf)} />
                {/if}
              {:else if leaf.section === "notes"}
                {@const view = notesView(leaf)}
                {#if view}
                  <NoteRow pair={view} onOpen={() => onSelect(leaf)} />
                {/if}
              {:else if leaf.section === "futureTreatment"}
                {@const view = hypothesisView(leaf)}
                {#if view && client}
                  <HypothesisTopicCard
                    g={view}
                    evalByIntervention={buildHypothesisEvalMap(client)}
                    {clientId}
                    {onStartChat}
                    onOpen={() => onSelect(leaf)}
                    only={leaf.hypothesisRef && { side: leaf.hypothesisRef.side, index: leaf.hypothesisRef.index }}
                  />
                {/if}
              {:else if leaf.section === "healthReports"}
                {@const view = reportView(leaf)}
                {#if view}
                  {@const rpin = client ? cellPin(client, "report", view.source.id, onPin) : undefined}
                  <ReportCell {view} items={openOnly(() => onSelect(leaf))} onlyIndex={leaf.reportRef?.index} pinned={rpin?.pinned ?? false} onTogglePin={rpin?.onTogglePin} />
                {/if}
              {:else if leaf.section === "chat"}
                <ThreadRow patient={leaf.chatPair?.patient} ai={leaf.chatPair?.ai} anchor={leaf.anchor} onOpen={() => onSelect(leaf)} />
              {:else if leaf.section === "allergies"}
                {@const view = allergyView(leaf)}
                {#if view}
                  <AllergyRow {view} onOpen={() => onSelect(leaf)} />
                {/if}
              {:else if leaf.section === "familyHistory"}
                {@const view = familyView(leaf)}
                {#if view}
                  <FamilyRow {view} onOpen={() => onSelect(leaf)} />
                {/if}
              {:else if leaf.section === "definitions"}
                {@const view = glossaryView(leaf)}
                {#if view}
                  <GlossaryTermPreview term={view.term} definition={view.definition} anchor={leaf.anchor} onOpen={() => onSelect(leaf)} client={client ?? undefined} {onPin} />
                {/if}
              {:else if leaf.section === "docInference"}
                <QuestionPreview group={leaf.context ?? ""} question={leaf.label} anchor={leaf.anchor} onOpen={() => onSelect(leaf)} client={client ?? undefined} {onPin} />
              {:else}
                <button class="search-row" onclick={() => onSelect(leaf)}>
                  <span class="search-row-label">{leaf.label}</span>
                  {#if leaf.context}<span class="search-row-context">{leaf.context}</span>{/if}
                </button>
              {/if}
            {/each}
          </section>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .search-panel.home {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 60vh; text-align: center;
  }
  .search-box { display: flex; align-items: center; gap: 0.5rem; width: 100%; max-width: 560px; }
  .search-panel.home .search-box { max-width: 480px; }
  .search-input {
    flex: 1 1 auto; box-sizing: border-box; margin: 0;
    padding: 0.6rem 0.8rem; border: 1px solid var(--border); border-radius: 8px;
    font: inherit; font-size: 1rem; min-height: 44px;
  }
  .search-panel.home .search-input { font-size: 1.15rem; padding: 0.75rem 1rem; }
  .search-input:focus { outline: none; border-color: var(--accent); }
  .search-close {
    flex: none; border: none; background: none; cursor: pointer; font-size: 1rem;
    color: var(--muted); padding: 0.4rem 0.5rem; border-radius: 6px;
  }
  .search-close:hover { color: var(--accent); background: rgba(0,0,0,0.05); }
  .search-results { margin-top: 1rem; }
  .search-group { margin-bottom: 1.25rem; }
  .search-group h3 { margin: 0 0 0.4rem; font-size: 0.85rem; text-transform: uppercase; opacity: 0.6; }
  .search-row { display: flex; align-items: baseline; gap: 0.5rem; width: 100%; text-align: left; padding: 0.5rem 0.6rem; border: none; background: none; cursor: pointer; border-radius: 6px; }
  .search-row:hover { background: rgba(0,0,0,0.05); }
  .search-row-label { font-weight: 500; }
  .search-row-context { opacity: 0.7; font-size: 0.85rem; }
  .search-empty { opacity: 0.6; }
</style>
