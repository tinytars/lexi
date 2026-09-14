<script lang="ts">
  import type { Client, MarkerResult } from "./types";
  import { resolveRange } from "@pablotech/akesi-pil/ranges";
  import { displayScaleFor, fmtNum, type UnitSystem } from "./units";
  import { normalizeSeries } from "@pablotech/akesi-pil/unit-systems";
  import MarkerSummary from "./MarkerSummary.svelte";

  // M85 Phase 9 — extracted verbatim from MarkerChart.svelte's inline `.info-panel` so it can
  // render standalone in MarkersTab's right-hand column (one panel shared across the tall list)
  // as well as inline inside MarkerChart itself (the Family cross-client grid, unchanged).
  // Recomputes personal/displayScale/valueRows independently rather than taking them as props —
  // mirrors how search-index.ts's adapters already re-derive each source component's own logic.
  interface Props {
    name: string;
    rows: MarkerResult[];
    client: Client;
    unitSystem?: UnitSystem;
  }
  let { name, rows, client, unitSystem = "metric" }: Props = $props();

  const normRows = $derived(normalizeSeries(rows));
  const baseUnit = $derived(normRows[0]?.unit ?? "");

  const personal = $derived(resolveRange(name, client));
  const dataMaxAbs = $derived(normRows.length > 0 ? Math.max(...normRows.map((r) => Math.abs(r.value))) : 0);
  const scaleInfo = $derived(displayScaleFor(name, baseUnit, dataMaxAbs, unitSystem));

  // All readings for this marker, newest first, scaled to the displayed unit.
  const valueRows = $derived.by(() => {
    const { scale, unit } = scaleInfo;
    return [...normRows]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((r) => ({
        date: r.date,
        value: r.valueText ?? fmtNum(r.value * scale),
        unit: r.valueText ? "" : unit,
        fromComparison: r.fromComparison === true,
      }));
  });

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyValues() {
    const tsv = valueRows.map((v) => `${v.date}\t${v.value}${v.unit ? " " + v.unit : ""}`).join("\n");
    try {
      await navigator.clipboard.writeText(`${name}\n${tsv}`);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch { /* clipboard unavailable */ }
  }
</script>

<div class="marker-details" class:has-range={!!personal}>
  <MarkerSummary {name} {rows} {client} {unitSystem} />
  <div class="mc-values">
    <div class="mc-values-head">
      <span class="mc-values-label">Values ({valueRows.length})</span>
      {#if valueRows.some((v) => v.fromComparison)}<span class="mc-prior-note">○ from prior-study comparison</span>{/if}
      <button type="button" class="mc-copy" onclick={copyValues}>{copied ? "Copied ✓" : "Copy"}</button>
    </div>
    {#if valueRows.length > 0}
      <div class="mc-values-scroll">
        <table class="mc-values-table">
          <tbody>
            {#each valueRows as v (v.date)}
              <tr><td class="mc-v-date">{v.date}</td><td class="mc-v-val">{v.value}{v.unit ? " " + v.unit : ""}{#if v.fromComparison}<span class="mc-v-note"> ○</span>{/if}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="mc-values-empty">No readings on file.</p>
    {/if}
  </div>
</div>

<style>
  .marker-details { font-size: 0.86rem; line-height: 1.45; }
  .mc-values { margin-top: 0.5rem; }
  .has-range .mc-values { border-top: 1px solid var(--border); padding-top: 0.4rem; }
  .mc-values-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.3rem; }
  .mc-values-label { font-weight: 600; color: var(--muted); }
  .mc-prior-note { color: var(--muted); font-size: 0.7rem; font-style: italic; }
  .mc-v-note { color: var(--muted); }
  .mc-copy {
    border: 1px solid var(--border); background: var(--card); color: var(--fg);
    border-radius: 4px; padding: 0.1rem 0.5rem; font-size: 0.72rem; cursor: pointer;
  }
  .mc-copy:hover { background: var(--bg); }
  .mc-values-scroll { max-height: 9rem; overflow-y: auto; }
  .mc-values-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .mc-values-table td { padding: 0.1rem 0.2rem; border-bottom: 1px solid var(--border); }
  .mc-v-date { color: var(--muted); white-space: nowrap; }
  .mc-v-val { text-align: right; color: var(--fg); }
  .mc-values-empty { margin: 0; color: var(--muted); }
  @media print {
    .mc-values { display: none; }
  }
</style>
