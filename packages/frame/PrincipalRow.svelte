<script lang="ts">
  import type { Snippet } from "svelte";
  import LeafCard from "./LeafCard.svelte";
  import PrincipalChip from "./PrincipalChip.svelte";
  import Button from "./Button.svelte";
  import type { LeafMenuItem } from "./menu-items";
  import { toneBorder, type PrincipalTone } from "./principal-tone";

  // One shape for every principal, whatever it is and whatever state it is in. Reading order is
  // always chip, then name, then ONE sentence, then what you can do about it — so a list of mixed
  // rows is scanned down a column rather than read entry by entry.
  //
  // The sentence is a prop and never built here: a row that composed its own copy would need to know
  // what the principals mean, and that is the host app's vocabulary (this package ships to apps with
  // no clinicians in them). Everything destructive goes in `items` as a `danger` entry rather than
  // becoming a second red button beside the first.
  interface RowAction {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    testid?: string;
  }
  interface Props {
    chip: { label: string; tone?: PrincipalTone; title?: string };
    name: string;
    /** The one sentence: what this access is, when it ends, what the person can do next. */
    detail?: string;
    /** `warn` tints the sentence for a window about to close — the only state that is time-critical. */
    detailTone?: "muted" | "warn";
    primary?: RowAction;
    secondary?: RowAction;
    items?: LeafMenuItem[];
    /** An ended or removed principal: it keeps its word and loses its colour. */
    dimmed?: boolean;
    testid?: string;
    /** Anything that belongs inside this row rather than after it — a duration choice, a log. */
    children?: Snippet;
  }
  let {
    chip,
    name,
    detail,
    detailTone = "muted",
    primary,
    secondary,
    items = [],
    dimmed = false,
    testid,
    children,
  }: Props = $props();

  const tone = $derived<PrincipalTone>(dimmed ? "muted" : (chip.tone ?? "muted"));
</script>

<div class="principal-row" class:dimmed data-testid={testid}>
  <LeafCard {items} borderColor={toneBorder(tone)}>
    {#snippet title()}
      <PrincipalChip label={chip.label} {tone} title={chip.title} />
      <span class="pr-name">{name}</span>
    {/snippet}
    {#if detail}
      <p class="pr-detail" class:warn={detailTone === "warn"}>{detail}</p>
    {/if}
    {#if children}{@render children()}{/if}
    {#if primary || secondary}
      <div class="pr-actions">
        {#if primary}
          <Button primary disabled={primary.disabled} onclick={primary.onClick} data-testid={primary.testid}>{primary.label}</Button>
        {/if}
        {#if secondary}
          <Button disabled={secondary.disabled} onclick={secondary.onClick} data-testid={secondary.testid}>{secondary.label}</Button>
        {/if}
      </div>
    {/if}
  </LeafCard>
</div>

<style>
  .pr-name { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  /* Dimmed rather than faded: opacity would take the contrast ratio down with it. */
  .principal-row.dimmed .pr-name { font-weight: 500; color: var(--muted); }
  .pr-detail { margin: 0 0.3rem 0.45rem; font-size: 0.85rem; color: var(--muted); }
  .pr-detail.warn { color: var(--warn); }
  .pr-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0 0.3rem 0.2rem; }
</style>
