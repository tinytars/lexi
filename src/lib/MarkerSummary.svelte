<script lang="ts">
  import type { Client, MarkerResult } from "./types";
  import { resolveRange } from "@pablotech/akesi-pil/ranges";
  import { displayScaleFor, fmtNum, fmtRange, type UnitSystem } from "./units";
  import { normalizeSeries, toCanonical } from "@pablotech/akesi-pil/unit-systems";
  import { PRODUCT_NAME } from "./brand";

  // M86 Phase 4 — extracted from MarkerDetails.svelte's meaning/range block. Recomputes
  // personal/displayScale independently rather than taking them as props, mirroring how
  // MarkerDetails itself re-derives from MarkerChart's original inline logic.
  interface Props {
    name: string;
    rows: MarkerResult[];
    client: Client;
    unitSystem?: UnitSystem;
  }
  let { name, rows, client, unitSystem = "metric" }: Props = $props();

  const normRows = $derived(normalizeSeries(rows));
  const baseUnit = $derived(normRows[0]?.unit ?? "");
  function toBase(v: number | null | undefined, fromUnit: string): number | null | undefined {
    return v == null || fromUnit === baseUnit ? v : toCanonical(name, fromUnit, v).value;
  }

  const personal = $derived(resolveRange(name, client));
  const dataMaxAbs = $derived(normRows.length > 0 ? Math.max(...normRows.map((r) => Math.abs(r.value))) : 0);
  const scaleInfo = $derived(displayScaleFor(name, baseUnit, dataMaxAbs, unitSystem));
</script>

{#if personal}
  {@const scaledLow = personal.low != null ? toBase(personal.low, personal.unit)! * scaleInfo.scale : null}
  {@const scaledHigh = personal.high != null ? toBase(personal.high, personal.unit)! * scaleInfo.scale : null}
  {@const aiText = fmtRange(scaledLow, scaledHigh, scaleInfo.unit)}
  {@const gLow = personal.generalLow != null ? toBase(personal.generalLow, personal.unit)! * scaleInfo.scale : null}
  {@const gHigh = personal.generalHigh != null ? toBase(personal.generalHigh, personal.unit)! * scaleInfo.scale : null}
  {@const generalText = fmtRange(gLow, gHigh, scaleInfo.unit)}
  {@const showImperial = unitSystem === "imperial" && personal.explanationImperial}
  {#if personal.meaning}
    <p class="mc-meaning"><span class="mc-meaning-label">What this is:</span> {personal.meaning}</p>
  {/if}
  <div class="ai-discussion">
    <p class="gen-head"><span class="gen-badge">{PRODUCT_NAME}</span> Personalized analysis</p>
    {#if generalText}
      <p class="range-line">
        <span class="ai-label">General range:</span> {generalText}{#if personal.generalExplanation} — {personal.generalExplanation}{/if}
      </p>
    {/if}
    <p class="range-line">
      <span class="ai-label">Personalized range:</span> {aiText}
    </p>
    {#each (showImperial ? personal.explanationImperial! : personal.explanation).split(/\n\n+/) as para (para)}
      <p class="explanation">{para}</p>
    {/each}
  </div>
{/if}

<style>
  .ai-discussion { border-left: 3px solid var(--gen); padding-left: 0.55rem; margin-bottom: 0.5rem; }
  .gen-head { margin: 0 0 0.35rem; font-size: 0.72rem; font-weight: 600; color: var(--gen); }
  .mc-meaning { margin: 0 0 0.5rem; color: var(--fg); font-size: 0.86rem; line-height: 1.45; }
  .mc-meaning-label { font-weight: 600; color: var(--muted); }
  .range-line { margin: 0 0 0.4rem; color: var(--fg); font-variant-numeric: tabular-nums; font-size: 0.86rem; line-height: 1.45; }
  .ai-label { font-weight: 600; color: var(--gen); }
  .explanation { margin: 0 0 0.4rem; color: var(--fg); font-size: 0.86rem; line-height: 1.45; }
  .explanation:last-of-type { margin-bottom: 0; }
  @media print {
    .explanation {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  }
</style>
