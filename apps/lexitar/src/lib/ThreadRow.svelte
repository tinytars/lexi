<script lang="ts">
  import TurnCard from "./TurnCard.svelte";

  // M91 Phase 3 — search-only companion to the sidebar's own thread row, which stays separate:
  // that one is inherently interactive (Rename/Pin/Delete, bindable rename state), none of which a
  // search preview has any business carrying. Takes just the anchor a `SearchableLeaf` already
  // carries rather than a full `Thread`, so `SearchPanel` needs no new `threads` prop.
  // M92 Phase 5 — mirrors StudyRow's patient/AI pair, so the preview shows the thread's actual
  // first exchange rather than a title derived twice.
  interface Props { patient?: string; ai?: string; anchor: string; onOpen?: () => void }
  let { patient, ai, anchor, onOpen }: Props = $props();
</script>

<TurnCard
  {anchor}
  {onOpen}
  patient={patient ? patientTurn : undefined}
  ai={ai ? aiTurn : undefined}
  patientEmpty="No message yet."
  aiEmpty="No reply yet."
/>

{#snippet patientTurn()}<p class="tr-text">{patient}</p>{/snippet}
{#snippet aiTurn()}<p class="tr-text">{ai}</p>{/snippet}

<style>
  .tr-text { margin: 0; font-size: 0.9rem; line-height: 1.45; color: var(--fg); }
</style>
