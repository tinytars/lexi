<script lang="ts">
  import type { Snippet } from "svelte";
  import LeafCard from "@tinytars/frame/LeafCard.svelte";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import { openOnly } from "@tinytars/frame/LeafActionMenu.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { PRODUCT_NAME } from "./brand";

  // THE turn-tuple cell: a patient turn beside a LexiTar turn, in a LeafCard.
  //
  // Both halves ALWAYS render. When one side did not happen it shows an empty state saying so,
  // rather than collapsing — that is what makes a cell read as a conversation with a gap instead of
  // as a different kind of thing. This shape was hand-rolled at eighteen call sites, each
  // re-deriving the same LeafCard + .rg-grid + two bubbles + empty states; the props below are the
  // smallest set that let the richer ones (row actions, pins, counter titles, bubble meta,
  // below-bubble footers) share it instead of copying it.
  //
  // What it deliberately does NOT do, because each is a single consumer that would turn this into a
  // config object: arbitrary personas or N bubbles per column (HealthReports), a non-bubble half
  // (MarkerChart's chart), N rows per card (HypothesisTopicCard). Those stay bespoke on purpose.
  interface Props {
    anchor?: string;
    /** Renders a HeadingAnchor title. Omit BOTH this and titleContent for a titleless card. */
    label?: string;
    /** A free-form title instead of the anchor+label one — e.g. Allergies/Family's "#3" counter. */
    titleContent?: Snippet;
    /** A secondary marker beside the label, e.g. Exploration's "Due soon". */
    tag?: string;
    /** Search-preview only; merged with `items`. */
    onOpen?: () => void;
    items?: LeafMenuItem[];
    pinned?: boolean;
    onTogglePin?: () => void;

    patient?: Snippet;
    ai?: Snippet;
    /** Shown in place of a missing half — say WHY it is absent, not just that it is. */
    patientEmpty?: string;
    aiEmpty?: string;
    /** Bubble pass-throughs (PersonaBubble's own label/meta). */
    patientMeta?: string;
    aiMeta?: string;
    aiLabel?: string;
    /** Content inside the column but BELOW the bubble — a reference card, a translate error. */
    patientAfter?: Snippet;
    aiAfter?: Snippet;
    /**
     * The LexiTar turn is in flight. A third state, distinct from present and absent: mid-answer
     * the AI half must never read "No result yet — regenerate the Translation", which is both wrong
     * and alarming while a reply is streaming.
     */
    aiPending?: boolean;
    aiPendingText?: string;
  }
  let {
    anchor, label, titleContent, tag, onOpen,
    items = [], pinned = false, onTogglePin,
    patient, ai, patientEmpty = "No patient question.",
    aiEmpty = `No ${PRODUCT_NAME} result yet — regenerate the Translation.`,
    patientMeta, aiMeta, aiLabel = PRODUCT_NAME, patientAfter, aiAfter,
    aiPending = false, aiPendingText = "…",
  }: Props = $props();

  let menuItems = $derived([...openOnly(onOpen), ...items]);
  let hasDefaultTitle = $derived(!titleContent && !!label && !!anchor);
  let hasTitle = $derived(!!titleContent || hasDefaultTitle);
  // Exactly ONE element may carry the anchor id. When this card renders its own HeadingAnchor
  // title, that heading owns it — the convention everywhere else in the app, and what every one of
  // these call sites did before they shared this component. Only a titleless card takes the id
  // itself, because there is no heading to hold it. Putting it in both places broke getElementById
  // (first match wins, which could be the wrong cell) and Playwright's strict mode.
  let cardId = $derived(hasDefaultTitle ? undefined : anchor);
</script>

<LeafCard id={cardId} items={menuItems} {pinned} {onTogglePin} title={hasTitle ? cardTitle : undefined}>
  <div class="rg-grid">
    <div class="rg-col">
      {#if patient}
        <PersonaBubble persona="owner" label="Patient" meta={patientMeta}>{@render patient()}</PersonaBubble>
      {:else}
        <p class="leaf-row-empty">{patientEmpty}</p>
      {/if}
      {#if patientAfter}{@render patientAfter()}{/if}
    </div>
    <div class="rg-col">
      {#if aiPending}
        <PersonaBubble persona="assistant" label={aiLabel} meta={aiMeta}>
          <span class="turn-pending">{aiPendingText}</span>
        </PersonaBubble>
      {:else if ai}
        <PersonaBubble persona="assistant" label={aiLabel} meta={aiMeta}>{@render ai()}</PersonaBubble>
      {:else}
        <p class="leaf-row-empty">{aiEmpty}</p>
      {/if}
      {#if aiAfter}{@render aiAfter()}{/if}
    </div>
  </div>
</LeafCard>

{#snippet cardTitle()}
  {#if titleContent}
    {@render titleContent()}
  {:else}
    <span class="turn-topic">
      <HeadingAnchor anchor={anchor!} label={"Copy link to " + label}>{label}</HeadingAnchor>
      {#if tag}<span class="turn-tag">{tag}</span>{/if}
    </span>
  {/if}
{/snippet}

<style>
  .turn-topic { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .turn-tag { margin-left: 0.4rem; color: var(--p-assistant); }
  .turn-pending { color: var(--muted); font-style: italic; }
</style>
