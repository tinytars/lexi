<script lang="ts">
  import { asPermalink, type Permalink } from "./permalink";
  import type { LeafRef } from "./types";

  // M69 — a pasted-permalink message renders as this card instead of raw text. Two kinds
  // (wrong-patient, unresolved) are inert; every other kind, including "section", navigates.
  // W46 — deliberately structural (not `ReferenceTurnData`'s `ReferenceKind`): this card also
  // renders `NoteAttachment` (Notes.svelte, NoteRow.svelte), whose `kind` union covers every leaf
  // type Annotate now reaches and doesn't need to stay in lockstep with ReferenceKind — the only
  // members that matter here are the two INERT_NOTE keys below, everything else is opaque.
  interface ReferenceLike {
    kind: string;
    // W72 — LeafRef, not Permalink: a note attachment's pointer is stored patient data and its type
    // lives in types.ts, which no longer knows the app's tab union (docs/cross-app/06). This is the
    // one place the widening is undone, by asPermalink's real check rather than a cast.
    permalink: LeafRef;
    preview: { title: string; subtitle?: string; tag: string };
  }
  interface Props {
    reference: ReferenceLike;
    onNavigate?: (patch: Partial<Permalink>) => void;
  }
  let { reference, onNavigate }: Props = $props();

  const INERT_NOTE: Record<string, string> = {
    "wrong-patient": "This link is for a different patient — switch patients first",
    unresolved: "This link's target could not be found",
  };
  let inert = $derived(reference.kind in INERT_NOTE);

  // Never forward `client` — a resolved reference only ever exists for the currently-active
  // client, so navigating from it must not touch selectedClientId (App.svelte's navigate() treats
  // an absent `client` key differently from an explicit undefined one; parseHash always returns
  // one, so omitting it here — not spreading the permalink — is the fix).
  function navigate() {
    const pl: Permalink = asPermalink(reference.permalink);
    onNavigate?.({ tab: pl.tab, section: pl.section, anchor: pl.anchor });
  }
</script>

{#if inert}
  <div class="reference-card inert">
    <span class="reference-tag">{reference.preview.tag}</span>
    <span class="reference-title">{reference.preview.title}</span>
    <span class="reference-note">{INERT_NOTE[reference.kind]}</span>
  </div>
{:else}
  <button class="reference-card" onclick={navigate}>
    <span class="reference-tag">{reference.preview.tag}</span>
    <span class="reference-title">{reference.preview.title}</span>
    {#if reference.preview.subtitle}
      <span class="reference-subtitle">{reference.preview.subtitle}</span>
    {/if}
  </button>
{/if}

<style>
  .reference-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: white;
    font: inherit;
    text-align: left;
    max-width: 100%;
  }
  button.reference-card {
    cursor: pointer;
  }
  button.reference-card:hover {
    border-color: var(--accent);
  }
  .reference-card.inert {
    background: var(--band);
    color: var(--muted);
  }
  .reference-tag {
    display: inline-block;
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
  }
  .reference-card.inert .reference-tag {
    color: var(--muted);
  }
  .reference-title {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .reference-subtitle {
    font-size: 0.78rem;
    color: var(--muted);
  }
  .reference-note {
    font-size: 0.78rem;
  }
</style>
