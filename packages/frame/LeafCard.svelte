<script lang="ts">
  import type { Snippet } from "svelte";
  import LeafActionMenu from "./LeafActionMenu.svelte";
  import type { LeafMenuItem } from "./menu-items";

  // M86 Phase 1 — the one shared leaf-card shell: a soft gray rounded card with an optional
  // full-width header row (title left, LeafActionMenu right). Generalizes the `.report-group` +
  // `.ct-topic-row`/`.row-actions` pattern Treatment/Study/FutureTreatment each hand-rolled
  // identically.
  // M88 — the two-column body grid (`.rg-grid`/`.rg-col`) moved in here too, as `:global()`, once
  // a 5th/6th caller (Markers, Chat) was about to copy it a 5th/6th time. Callers still pass their
  // own body as `children` and layer their own additive modifier classes on top (e.g. `.rg-dx`,
  // `.ft-row`).
  interface Props {
    id?: string;
    title?: Snippet;
    items?: LeafMenuItem[];
    pinned?: boolean;
    onTogglePin?: () => void;
    dashed?: boolean;
    borderColor?: string;
    children: Snippet;
  }
  let { id, title, items = [], pinned = false, onTogglePin, dashed = false, borderColor, children }: Props = $props();
</script>

<div class="leaf-card" class:dashed {id} style:border-color={borderColor}>
  {#if title || items.length || onTogglePin}
    <div class="leaf-card-head">
      <span class="persona-head-left">{#if title}{@render title()}{/if}</span>
      {#if items.length || onTogglePin}
        <div class="row-actions">
          <LeafActionMenu {items} {pinned} {onTogglePin} />
        </div>
      {/if}
    </div>
  {/if}
  {@render children()}
</div>

<style>
  .leaf-card { border: 1px solid var(--border); border-radius: 16px; background: var(--bg); padding: 0.5rem; margin-bottom: 0.6rem; }
  .leaf-card.dashed { border-style: dashed; }
  .leaf-card-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.15rem 0.3rem 0.45rem; }
  .row-actions { display: flex; align-items: center; gap: 0.35rem; flex: none; }
  :global(:root) {
    --rg-side-w: 80%;
    --rg-side-w-narrow: 92%;
  }
  :global(.rg-grid) { display: flex; flex-direction: column; row-gap: 0.5rem; }
  :global(.rg-grid) > :global(*:first-child) {
    align-self: flex-end;
    max-width: var(--rg-side-w);
    text-align: right;
  }
  /* :not(:first-child) makes this and the rule above mutually exclusive for a lone child
     (the old .single case) — no separate override needed. */
  :global(.rg-grid) > :global(*:last-child:not(:first-child)) {
    align-self: flex-start;
    max-width: var(--rg-side-w);
    text-align: left;
  }
  @media (max-width: 480px) {
    :global(:root) { --rg-side-w: var(--rg-side-w-narrow); }
  }
  :global(.rg-col) { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
  :global(.leaf-side) {
    align-self: flex-start;
    max-width: var(--rg-side-w);
    text-align: left;
  }
</style>
