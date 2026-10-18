<script lang="ts">
  import type { Client } from "./types";
  import AnalysisItemCard from "./AnalysisItemCard.svelte";
  import type { PinItem } from "./body-pin";
  import { filterByLeaf } from "@tinytars/frame/group-filter";
  import { analysisItemsFor } from "./analysis-items";
  import { ANALYSIS_NAV } from "./analysis-nav";

  // ONE Analysis block, parameterized by section key.
  //
  // This replaces six components — HealthProgression, OnTreatment, SystemAnalysis,
  // PatternAntipattern, ClinicalSynthesis, FinalThoughts — which had converged to the same 34 lines
  // wearing six names. Ignoring identifiers and comments they held exactly two templates, and even
  // that split was false: the "single item" pair rendered `rows[0]` where the others looped, but
  // both of their *Items() return arrays, so an {#each} over a 1-element array is identical.
  //
  // Everything they needed already existed: analysisItemsFor dispatches by section key over the same
  // BY_SECTION map, ANALYSIS_NAV carries the per-section data, AnalysisItemCard is the cell. The six
  // files were a hand-rolled dispatcher over a map that was already there.
  interface Props {
    section: string;
    client: Client;
    activeLeaf?: string | null;
    onPin?: PinItem;
  }
  let { section, client, activeLeaf = null, onPin }: Props = $props();

  const nav = $derived(ANALYSIS_NAV.find((n) => n.key === section));
  const rows = $derived(filterByLeaf(analysisItemsFor(client, section), activeLeaf, (r) => r.anchor));
</script>

<!-- The wrapper class stays per-section: e2e selects on it (cover-render.spec.ts), and it is the
     one piece of these components' identity worth keeping. -->
<div class="analysis-block leaf-section {nav?.cls ?? section}">
  {#if rows.length === 0}
    <p class="leaf-empty">No {nav?.emptyNoun ?? section} on file for {client.displayName}.</p>
  {:else}
    <div class="turn-list">
      {#each rows as r (r.anchor)}
        <AnalysisItemCard item={r} {client} {onPin} />
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Was on two of the six only, undocumented; applied uniformly now. */
  @media print { .analysis-block { break-inside: avoid; } }
</style>
