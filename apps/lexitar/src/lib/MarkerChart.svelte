<script lang="ts">
  import { statusWord, chartLabel as buildChartLabel } from "./marker-status";
  import type { Client, MarkerResult, NoteAttachment } from "./types";
  import { describeAiError } from "./ai-error";
  import type { MarkerDelta, DeltaChange } from "@pablotech/akesi/marker-deltas";
  import { resolveRange } from "@pablotech/akesi/ranges";
  import { chartGeometry } from "./marker-chart-geometry";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import { PRODUCT_NAME } from "./brand";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";
  import LeafCard from "@tinytars/frame/LeafCard.svelte";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import MarkerDetails from "./MarkerDetails.svelte";
  import MarkerSummary from "./MarkerSummary.svelte";
  import { fmtNum, type UnitSystem } from "./units";
  import { normalizeSeries } from "@pablotech/akesi/unit-systems";
  import type { Permalink } from "./permalink";

  interface Props {
    name: string;
    rows: MarkerResult[];
    client: Client;
    clientId?: string | null;
    caption?: string;
    highlighted?: boolean;
    windowYears: number;
    unitSystem?: UnitSystem;
    status?: "safe" | "warn" | "danger" | "unknown";
    // M85 Phase 9 — "large" is the Markers tall-list default; "compact" (untouched call sites,
    // e.g. Family's cross-client grid and the search-results preview pre-Phase-9-trailing-edit)
    // keeps today's plot size.
    size?: "compact" | "large";
    expanded?: boolean;
    onToggle?: () => void;
    chartId?: string;
    delta?: MarkerDelta | null;
    // When provided, wires the combined star/⋮ control's Pin/Unpin to watchlist membership for
    // this marker (W30, merged onto LeafActionMenu in M72 Phase 8). Omitted for ratios and the
    // read-only Family view, which never had a pin control.
    onToggleWatchlist?: (name: string) => void;
    // M59/Phase 4 — provider-only per-marker Ranges Translate. Shown only when this marker has no
    // personalized range yet (canTranslate && !personal); the parent (MarkersTab) closes over this
    // marker's client+name so onTranslate here takes no arguments, matching onToggle's shape.
    canTranslate?: boolean;
    onTranslate?: () => Promise<void>;
    // M70/Phase 0 — plumbing only; wired to a "Chat" button in a later phase.
    onStartChat?: (pl: Permalink) => void;
    // M-annotate — this marker/ratio's "Annotate" menu item hands its attachment up to the shell.
    onCreateNote?: (attachment: NoteAttachment) => void;
  }
  let {
    name,
    rows,
    client,
    clientId = null,
    caption,
    highlighted = false,
    windowYears,
    unitSystem = "metric",
    status = "unknown",
    size = "compact",
    expanded = false,
    onToggle,
    chartId,
    delta = null,
    onToggleWatchlist,
    canTranslate = false,
    onTranslate,
    onStartChat,
    onCreateNote,
  }: Props = $props();

  const arrow = (d: DeltaChange) => (d.direction === "up" ? "↑" : d.direction === "down" ? "↓" : "→");
  const signed = (n: number) => (n >= 0 ? "+" : "") + fmtNum(n);
  const pctStr = (p: number | null) =>
    p == null ? "" : `${p >= 0 ? "+" : ""}${Math.abs(p) >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
  // The delta is computed in stored units; scale its absolute change to whatever the
  // chart is displaying. Percent is scale-invariant. valueText markers (titers) have a
  // stand-in numeric value, so show direction + % only, never a unit-bearing absolute.
  const deltaTitle = $derived.by(() => {
    if (!delta) return "";
    const u = computed.displayUnit;
    const fmtAbs = (c: DeltaChange) =>
      delta!.latest.valueText ? "" : `${signed(c.abs * computed.displayScale)}${u ? " " + u : ""} `;
    const lines = [
      `vs prior reading ${delta.prior.date} → ${delta.latest.date}: ${fmtAbs(delta.vsPrior)}(${pctStr(delta.vsPrior.pct) || "n/a"})`,
    ];
    if (delta.vsBaseline && delta.baseline) {
      lines.push(
        `vs baseline ${delta.baseline.date} → ${delta.latest.date}: ${fmtAbs(delta.vsBaseline)}(${pctStr(delta.vsBaseline.pct) || "n/a"})`,
      );
    }
    return lines.join("\n");
  });

  // Per-reading unit reconciliation: a mixed-unit series (US+SI in one xls) is folded to a
  // single canonical unit; a single-unit series is untouched. Matches marker-deltas, so the
  // delta prop and this chart always share one basis.
  const normRows = $derived(normalizeSeries(rows));
  const baseUnit = $derived(normRows[0]?.unit ?? "");
  const personal = $derived(resolveRange(name, client));

  const colorVar = $derived(
    status === "danger" ? "var(--alert)" : status === "warn" ? "var(--warn)" : status === "safe" ? "var(--safe)" : "var(--accent)",
  );

  // W70 — the same fact in WORDS, and W71 moved the judgement itself into marker-status.ts so it can
  // be tested by behaviour rather than by grepping this file for the string "out of range".
  const statusText = $derived(statusWord(status));

  const chartLabel = $derived.by(() =>
    buildChartLabel({
      name,
      value: computed.latest
        ? (computed.latest.valueText ?? fmtNum(computed.latest.value * computed.displayScale))
        : undefined,
      unit: computed.latest && !computed.latest.valueText ? computed.displayUnit : undefined,
      status,
      date: computed.latest?.date,
    }),
  );

  // M85 Phase 9 — promoted from hardcoded constants to a size-keyed lookup; the tick/scale
  // derivation below already parameterizes on plotW/plotH, so this is parameterization, not an
  // algorithm change. `size` doesn't change post-mount for a given chart instance, so a plain
  // lookup (not $derived) is fine — matches how these were already plain consts.
  const SIZES = {
    compact: { W: 260, H: 110, PAD: { top: 8, right: 8, bottom: 28, left: 32 } },
    large: { W: 640, H: 220, PAD: { top: 12, right: 16, bottom: 36, left: 48 } },
  } as const;
  const { PAD } = SIZES[size];
  // M89 — the viewBox width was still fixed at 640 after M88 narrowed the leaf, so a large chart's
  // rendered column (~330-350px inside the symmetric rg-grid) downscales the SVG by roughly half,
  // shrinking axis labels along with it. Measured off .mc-chart itself (grid-track-determined width,
  // independent of the SVG's own content, so this can't feed back into itself either).
  let mcChartEl = $state<HTMLDivElement | undefined>(undefined);
  let measuredW = $state<number | null>(null);
  $effect(() => {
    if (size !== "large" || !mcChartEl) return;
    const ro = new ResizeObserver(([entry]) => { measuredW = entry.contentRect.width; });
    ro.observe(mcChartEl);
    return () => ro.disconnect();
  });
  const W = $derived(size === "large" ? Math.max(measuredW ?? SIZES.large.W, 160) : SIZES.compact.W);
  const plotW = $derived(W - PAD.left - PAD.right);
  // M90 — with the AI column no longer sharing a row with the chart, H derives from the chart's
  // own measured width via the SIZES.large aspect ratio, instead of matching the AI column's height.
  const ASPECT = SIZES.large.H / SIZES.large.W;
  const H = $derived(size === "large" ? Math.max(Math.round(W * ASPECT), 160) : SIZES.compact.H);
  const plotH = $derived(H - PAD.top - PAD.bottom);

  // W76 — the plot's arithmetic lives in marker-chart-geometry.ts now, testable without a DOM. What
  // stays here is what the component actually owns: the measured width, and the markup.
  let computed = $derived(
    chartGeometry({
      rows: normRows,
      name,
      baseUnit,
      unitSystem,
      windowYears,
      personal,
      pad: PAD,
      plotW,
      plotH,
      now: Date.now(),
    }),
  );

  const axisY = $derived(H - PAD.bottom);

  // M59/Phase 4 — errors are scoped to this one marker (not a page-level alert); success is implicit
  // (the parent merges the returned range into client.personalizedRanges and re-renders, so `personal`
  // becomes truthy and this action's `{#if !personal}` guard hides it — no local "done" flag needed).
  let translating = $state(false);
  let translateError = $state<string | null>(null);
  async function doTranslate() {
    if (!onTranslate) return;
    translating = true;
    translateError = null;
    try {
      await onTranslate();
    } catch (e) {
      translateError = describeAiError(e);
    } finally {
      translating = false;
    }
  }

  // M-annotate — mirrors ChatTab.svelte's buildAttachment: a self-contained permalink + preview
  // back to this marker/ratio, using the same chartId/anchor the "Chat" item above already builds.
  function buildAttachment(): NoteAttachment {
    const latest = rows[rows.length - 1];
    return buildNoteAttachment(
      "marker",
      { client: clientId ?? undefined, tab: "labs", section: "markers", anchor: chartId },
      {
        title: name,
        subtitle: latest ? `${latest.valueText ?? latest.value} ${latest.unit} (${latest.date})` : undefined,
        tag: "Markers",
      },
    );
  }

  // M71 — Translate → Chat → Annotate → Details (no Edit/Delete here). Translate is leaf-specific
  // and leads (unlike the canonical contract's Edit-first order), so it's prepended manually; Chat/
  // Annotate come from the shared contract, with Details folded in as its trailing `extra`.
  function rowActions(): LeafMenuItem[] {
    const items: LeafMenuItem[] = [];
    if (canTranslate && !personal) {
      items.push({
        key: "translate",
        label: translating ? "Translating…" : "Translate",
        title: "Translate",
        disabled: translating,
        onClick: doTranslate,
      });
    }
    items.push(...standardLeafActions({
      chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "labs", section: "markers", anchor: chartId }),
      annotate: onCreateNote ? () => onCreateNote!(buildAttachment()) : undefined,
      extra: [{ key: "details", label: "Details", title: "Details", onClick: () => onToggle?.() }],
    }));
    return items;
  }

  // Phase 5 — size==='large' only: clicking the CHART opens the same details the ⋮ menu's "Details"
  // item does. W70 narrowed that from the whole card to the chart itself: the card wrapper was a
  // role="button" containing real buttons, and the guard that used to live here — bail out if the
  // click was inside .marker-head, so the ⋮ trigger did not also fire this — existed only because the
  // handler sat on an ancestor of the controls it had to ignore. A button around the figure, which
  // contains nothing interactive, needs no such guard.
</script>

{#snippet chartSvg()}
  <svg viewBox="0 0 {W} {H}" role="img" aria-label={chartLabel}>
    {#if computed.zones}
      {#if computed.zones.dangerLow}
        <rect x={PAD.left} y={computed.zones.dangerLow.y} width={plotW} height={computed.zones.dangerLow.h} fill="var(--alert-band)" />
      {/if}
      {#if computed.zones.warnLow}
        <rect x={PAD.left} y={computed.zones.warnLow.y} width={plotW} height={computed.zones.warnLow.h} fill="var(--warn-band)" />
      {/if}
      <rect x={PAD.left} y={computed.zones.safe.y} width={plotW} height={computed.zones.safe.h} fill="var(--safe-band)" />
      {#if computed.zones.warnHigh}
        <rect x={PAD.left} y={computed.zones.warnHigh.y} width={plotW} height={computed.zones.warnHigh.h} fill="var(--warn-band)" />
      {/if}
      {#if computed.zones.dangerHigh}
        <rect x={PAD.left} y={computed.zones.dangerHigh.y} width={plotW} height={computed.zones.dangerHigh.h} fill="var(--alert-band)" />
      {/if}
    {/if}
    <line x1={PAD.left} y1={axisY} x2={W - PAD.right} y2={axisY} stroke="var(--border)" stroke-width="1" />
    {#each computed.ticks as t, i (i)}
      <line x1={t.x} y1={axisY} x2={t.x} y2={axisY + 4} stroke="var(--muted)" stroke-width="1" />
      <text x={t.x} y={axisY + 14} text-anchor="middle" font-size="11" fill="var(--muted)">{t.label}</text>
    {/each}
    {#each computed.yLabels as yl, i (i)}
      <line x1={PAD.left - 4} y1={yl.y} x2={PAD.left} y2={yl.y} stroke="var(--muted)" stroke-width="1" />
      <text x={PAD.left - 6} y={yl.y + 3} text-anchor="end" font-size="11" fill="var(--muted)">{yl.label}</text>
    {/each}
    {#if computed.points}
      <path d={computed.path} fill="none" stroke={colorVar} stroke-width="1.5" />
      {#each computed.points as p, i (i)}
        <circle cx={p.cx} cy={p.cy} r="2.5" fill={p.r.fromComparison ? "none" : colorVar} stroke={colorVar} stroke-width={p.r.fromComparison ? 1.2 : 0}>
          <title>{p.r.date}: {p.r.valueText ?? `${fmtNum(p.r.value * computed.displayScale)} ${computed.displayUnit}`}{p.r.fromComparison ? " (from prior-study comparison)" : ""}</title>
        </circle>
      {/each}
    {:else}
      <text x={W / 2} y={PAD.top + plotH / 2} text-anchor="middle" font-size="10" fill="var(--muted)">
        no data in window
      </text>
    {/if}
  </svg>
{/snippet}

{#snippet latestMeta()}
  <!-- W65 — one copy. The large (Markers page) and small (report/family) renderings carried
       byte-identical badge/latest/delta blocks, which is why the stale-reading badge first landed in
       only one of them and did not show up where it was needed. -->
  {#if !personal}
    {#if canTranslate}
      {#if translateError}<span class="mc-badge translate-error">translate failed</span><span class="mc-translate-why">{translateError}</span>{/if}
    {:else}
      <span class="mc-badge nodata" title="no personalized range generated yet">no range</span>
    {/if}
  {/if}
  {#if !computed.latest}
    <span class="mc-badge nodata" title="no readings on file for this marker">no data</span>
  {:else}
    {#if computed.staleLatest}
      <!-- The window is a zoom, so the marker stays listed and its latest reading stays shown; what
           changes is that the card says the reading predates the window instead of pairing a
           current-looking value with a plot that reads "no data in window". -->
      <span class="mc-badge stale" title="latest reading {computed.latest.date} — before the selected window">
        last {computed.latest.date}
      </span>
    {/if}
    {#if statusText}
      <!-- In the shared snippet on purpose: this is exactly the badge that once landed in only one of
           the two renderings, which is why W65 unified them (:380-383). -->
      <span class="mc-badge status-word status-{status}">{statusText}</span>
    {/if}
    <span class="latest" style:color={colorVar}>
      {computed.latest.valueText ?? fmtNum(computed.latest.value * computed.displayScale)}
      {#if !computed.latest.valueText && computed.displayUnit}<span class="unit">{computed.displayUnit}</span>{/if}
    </span>
    {#if delta && !computed.staleLatest}
      <!-- A delta beside an empty plot reads as movement that just happened; it compares the last
           two readings on record, both of which are outside the window. -->
      <span class="mc-delta" title={deltaTitle}>
        {arrow(delta.vsPrior)}{#if !computed.latest.valueText} {signed(delta.vsPrior.abs * computed.displayScale)}{/if}{#if delta.vsPrior.pct != null} ({pctStr(delta.vsPrior.pct)}){/if}
      </span>
    {/if}
  {/if}
{/snippet}

{#if size === "large"}
  <LeafCard
    id={chartId}
    items={rowActions()}
    pinned={highlighted}
    onTogglePin={onToggleWatchlist ? () => onToggleWatchlist(name) : undefined}
  >
    {#snippet title()}
      <span class="marker">
        <HeadingAnchor anchor={chartId} assignId={false} label="Copy link to this marker"><span class="marker-name">{caption ?? name}</span></HeadingAnchor>
      </span>
    {/snippet}
    <!-- W70 — NOT role="button" any more. This div wraps the whole card, real <button> descendants
         included (the pin, the ⋮ menu, MarkerDetails' controls), and interactive content nested inside
         a role="button" is undefined behaviour for assistive tech — axe rates it `nested-interactive`,
         serious, ×6 on this view. The `.closest(".marker-head")` bail-out in onFigureClick was the
         paper-over: it stopped the outer handler firing for real buttons, but did nothing about the
         broken semantics a screen reader was handed.
         The affordance is now a real <button> around the chart itself, which is the thing that looks
         clickable and contains nothing interactive. -->
    <div class="rg-grid">
      <!-- M98 — CSS-token-matched (16px radius, var(--bg)) to look like a nested card rather than
           literally being a second LeafCard: bind:this below is watched by a ResizeObserver, which
           LeafCard has no way to forward, so nesting would shift what's measured. -->
      <div
        class="mc-chart"
        bind:this={mcChartEl}
        class:status-safe={status === "safe"}
        class:status-warn={status === "warn"}
        class:status-alert={status === "danger"}
        class:status-unknown={status === "unknown"}
      >
        {#if onToggle}
          <button
            type="button"
            class="mc-figure-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse details for ${caption ?? name}` : `Expand details for ${caption ?? name}`}
            onclick={() => onToggle?.()}
          >
            <figure>{@render chartSvg()}</figure>
          </button>
        {:else}
          <figure>{@render chartSvg()}</figure>
        {/if}
      </div>
      <div class="mc-side">
        <PersonaBubble persona="assistant" label={PRODUCT_NAME}>
          {@render latestMeta()}
          {#if expanded}
            <MarkerDetails {name} {rows} {client} {unitSystem} />
          {:else if personal}
            <MarkerSummary {name} {rows} {client} {unitSystem} />
          {:else if canTranslate}
            <p class="leaf-row-empty">No personalized range yet — use ⋮ → Translate to generate one.</p>
          {:else}
            <p class="leaf-row-empty">No personalized range yet.</p>
          {/if}
        </PersonaBubble>
      </div>
    </div>
  </LeafCard>
{:else}
  <LeafCard
    id={chartId}
    items={rowActions()}
    pinned={highlighted}
    onTogglePin={onToggleWatchlist ? () => onToggleWatchlist(name) : undefined}
    borderColor={colorVar}
  >
    {#snippet title()}
      <span class="marker">
        <HeadingAnchor anchor={chartId} assignId={false} label="Copy link to this marker"><span class="marker-name">{caption ?? name}</span></HeadingAnchor>
      </span>
    {/snippet}
    <div class="mc-caption">
      <div class="marker-meta">
        {@render latestMeta()}
      </div>
    </div>
    {@render chartSvg()}
    <div class="info-panel" class:collapsed={!expanded} class:has-range={!!personal}>
      <!-- W51 — a real PersonaBubble, not a styled-alike div: matches the size==="large" branch's
           own treatment above verbatim, so the compact layout's AI explanation gets the same head
           row/p-ai styling and inherits Speak from PersonaBubble itself, no special-casing. -->
      <PersonaBubble persona="assistant" label={PRODUCT_NAME}>
        <MarkerDetails {name} {rows} {client} {unitSystem} />
      </PersonaBubble>
    </div>
  </LeafCard>
{/if}

<style>
  .rg-grid { cursor: pointer; }
  .mc-chart {
    width: var(--rg-side-w);
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--bg);
    padding: 0.75rem;
    min-width: 0;
  }
  .mc-chart figure { margin: 0; padding: 0; border: none; border-radius: 0; background: none; }
  /* A transparent wrapper: the button exists for semantics and keyboard access, not for chrome. */
  .mc-figure-toggle {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    text-align: inherit;
    cursor: pointer;
  }
  .mc-figure-toggle > figure { margin: 0; }
  .mc-badge.status-word { font-weight: 600; }
  .mc-badge.status-safe { color: var(--safe); }
  .mc-badge.status-warn { color: var(--warn); }
  .mc-badge.status-danger { color: var(--alert); }
  .mc-chart.status-safe { border-color: var(--safe); }
  .mc-chart.status-warn { border-color: var(--warn); }
  .mc-chart.status-alert { border-color: var(--alert); }
  .mc-chart.status-unknown { border-color: var(--accent); }
  .mc-side { min-width: 0; }
  .mc-caption {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-bottom: 0.25rem;
    font-size: 0.875rem;
  }
  .marker { font-weight: 500; display: inline-flex; align-items: baseline; gap: 0.3rem; min-width: 0; }
  .marker-name { white-space: normal; overflow-wrap: break-word; }
  .marker-meta { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; min-width: 0; }
  .latest { font-variant-numeric: tabular-nums; }
  .unit { color: var(--muted); font-size: 0.75rem; margin-left: 0.2rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* Neutral (muted) by design — good/bad is carried by `status`; a change arrow must
     not imply the direction is good or bad. */
  .mc-delta {
    color: var(--muted);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: help;
  }
  .mc-badge {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.05rem 0.35rem;
    border-radius: 999px;
    align-self: center;
  }
  .mc-badge.nodata, .mc-badge.stale { color: var(--muted); background: var(--border); }
  .mc-badge.translate-error { color: var(--alert); background: var(--alert-band); }
  /* The reason, not just the fact: a title= tooltip is unreachable on a phone, and "translate
     failed" alone is exactly the dead end this milestone exists to remove. */
  .mc-translate-why { display: block; margin-top: 0.2rem; font-size: 0.75rem; color: var(--alert); }
  svg { width: 100%; height: auto; display: block; }
  .info-panel {
    margin-top: 0.4rem;
    padding: 0.5rem 0.6rem;
    background: var(--bg);
    border-left: 2px solid var(--accent);
    border-radius: 4px;
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .info-panel.collapsed { display: none; }
  @media print {
    /* Only panels with a personalized range print; the values table is a
       screen-only read/copy affordance and is omitted from the PDF (MarkerDetails'
       own print rule hides it). */
    .info-panel.collapsed.has-range { display: block; }
    .info-panel:not(.has-range) { display: none; }
    .info-panel { font-size: 0.7rem; padding: 0.3rem 0.4rem; }
    figure { break-inside: avoid; page-break-inside: avoid; }
  }
</style>
