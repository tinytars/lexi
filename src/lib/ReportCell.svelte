<script lang="ts" module>
  import type { Client, SourceRecord, DiseaseEntry } from "./types";
  import { sortPinnedFirst } from "./pin-sort";
  import { reportDateOf } from "@pablotech/akesi-pil/report-title";

  export interface ReportView { source: SourceRecord; diagnoses: DiseaseEntry[] }

  // Read-only pairing of each source with the diagnoses it produced — reads straight off `client`
  // (no draft/optimistic-delete awareness, since a search preview always reads the live,
  // already-saved client). HealthReports does its own draft-aware version of this pairing.
  export function buildReportRows(client: Client): ReportView[] {
    const diseases = client.factors?.diseases ?? [];
    return [...(client.sources ?? [])]
      .sort((a, b) => reportDateOf(b).localeCompare(reportDateOf(a)))
      .map((s) => ({ source: s, diagnoses: sortPinnedFirst(diseases.filter((d) => d.sourceId === s.id)) }));
  }
</script>

<script lang="ts">
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import LeafCard from "@tinytars/frame/LeafCard.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import PdfThumbnail from "@tinytars/frame/PdfThumbnail.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { reportAnchor, diagnosisAnchor } from "./anchor";
  import { reportTitleOf, reportDateOf as dateOf, REPORT_KIND_LABEL } from "@pablotech/akesi-pil/report-title";
  import { formatDay } from "@pablotech/akesi-pil/dates";
  import { PRODUCT_NAME } from "./brand";
  import { onlyIndexed } from "@tinytars/frame/filter";

  // W63 — ONE report cell, for the section and the search preview both.
  //
  // It was two: HealthReports.svelte rendered this block inline and ReportRow.svelte held a
  // near-copy for search, differing only in class prefix (.cr-* vs .rr-*) with four byte-identical
  // rule bodies. They had already drifted — the section grew per-diagnosis pins (M71 P6) and the
  // preview did not — which is the drift this consolidation removes the possibility of.
  //
  // Every difference between the two surfaces is a PROP, not a fork: the section passes actions and
  // pin handlers, the search preview passes `onOpen` and `onlyIndex` and nothing else. That is the
  // same read-only shape every other search preview has (SearchPanel takes no pin handler at all),
  // so Reports stays consistent with its neighbours rather than becoming the one pinnable preview.
  interface Props {
    view: ReportView;
    /** The card's own menu. Empty in the search preview beyond `openOnly`. */
    items?: LeafMenuItem[];
    /** The REPORT's pin (SourceRecord.pinned) — the same record its sidebar row writes (W62 P7). */
    pinned?: boolean;
    onTogglePin?: () => void;
    /** One DIAGNOSIS's pin (DiseaseEntry.pinned) — a finer, separate record; a report carries
     *  several. Absent = this surface cannot pin a diagnosis and shows no star on the bubble. */
    onTogglePinDiagnosis?: (d: DiseaseEntry) => void;
    /** M103 — a scoped search hit renders just the matched diagnosis. The index must stay the TRUE
     *  original index: diagnosisAnchor(source.id, i) has to line up with what
     *  search-index.ts's reportSearchLeaves computed. */
    onlyIndex?: number;
    /** Set only where the raw file is reachable — the section, not the preview. */
    clientId?: string | null;
    thumbnailUrl?: string;
    onOpenAttachment?: () => void;
  }
  let {
    view, items = [], pinned = false, onTogglePin, onTogglePinDiagnosis,
    onlyIndex, clientId = null, thumbnailUrl, onOpenAttachment,
  }: Props = $props();

  const dxIndices = $derived(onlyIndexed(view.diagnoses.map((_, i) => i), onlyIndex));
  const showThumbnail = $derived(!!clientId && !!thumbnailUrl && view.source.file.toLowerCase().endsWith(".pdf"));
</script>

<LeafCard {items} {pinned} {onTogglePin}>
  {#snippet title()}
    <span class="cr-title"><HeadingAnchor anchor={reportAnchor(view.source.id)} label="Copy link to this report">{reportTitleOf(view.source)}</HeadingAnchor></span>
  {/snippet}
  <div class="rg-grid">
    <div class="rg-col">
      <div class="cr-report-head">
        <PersonaBubble persona="provider" label="Hospital" meta={`${dateOf(view.source)} · ${REPORT_KIND_LABEL[view.source.kind]}`} />
        {#if showThumbnail}
          <PdfThumbnail url={thumbnailUrl!} onOpen={onOpenAttachment} />
        {/if}
      </div>
    </div>
    <div class="rg-col rg-dx">
      {#each dxIndices as i (view.diagnoses[i].id)}
        {@const d = view.diagnoses[i]}
        <PersonaBubble
          persona="assistant"
          label={PRODUCT_NAME}
          meta={d.date ? formatDay(d.date) : undefined}
          pinned={!!d.pinned}
          onTogglePin={onTogglePinDiagnosis ? () => onTogglePinDiagnosis(d) : undefined}
        >
          <div class="cr-dx"><HeadingAnchor anchor={diagnosisAnchor(view.source.id, i)} label="Copy link to this diagnosis">{d.diagnostic}</HeadingAnchor></div>
          {#if d.icdCodes?.length}<p class="cr-icd">{#each d.icdCodes as code}<span class="icd-chip">{code}</span>{/each}</p>{/if}
          {#if d.summary}<p class="cr-summary">{d.summary}</p>{/if}
        </PersonaBubble>
      {:else}
        <p class="leaf-row-empty">No diagnosis extracted from this report.</p>
      {/each}
    </div>
  </div>
</LeafCard>

<style>
  /* .rg-dx carries no rule of its own: it is LeafCard's :global(.rg-col), which both copies of this
     cell used to re-declare verbatim. The class name stays for the e2e selectors keyed on it. */
  .cr-title { font-weight: 600; font-size: 1rem; color: var(--fg); }
  .cr-report-head { display: flex; flex-direction: column; align-items: flex-end; gap: 0.4rem; }
  .cr-dx { font-weight: 600; font-size: 0.95rem; color: var(--fg); }
  .cr-icd { margin: 0.4rem 0 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .icd-chip { font-size: 0.75rem; font-variant-numeric: tabular-nums; background: var(--surface); border: 1px solid var(--p-assistant); color: var(--p-assistant); border-radius: 4px; padding: 0.02rem 0.32rem; }
  .cr-summary { margin: 0.45rem 0 0; font-size: 0.86rem; line-height: 1.45; color: var(--fg); }
</style>
