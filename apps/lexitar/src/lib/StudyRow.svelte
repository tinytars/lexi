<script lang="ts">
  import type { Pair } from "./study-pairs";
  import TurnCard from "./TurnCard.svelte";
  import { studyAnchor } from "./anchor";

  // M91 Phase 3 — extracted from Study.svelte's private `studyRow` snippet (the read-only/patient
  // view; the editable provider row stays as Study's own `entryRow`, since search previews are
  // always read-only). `onOpen` is set only by the search preview (mirrors MarkerChart's "Details"
  // action) — the home tab omits it.
  interface Props { pair: Pair; onOpen?: () => void }
  let { pair: p, onOpen }: Props = $props();
</script>

<TurnCard
  anchor={studyAnchor(p.label)}
  label={p.label}
  {onOpen}
  patient={p.detail ? patientTurn : undefined}
  ai={p.result ? aiTurn : undefined}
  patientEmpty="No patient input on file."
/>

{#snippet patientTurn()}<p class="sr-text">{p.detail}</p>{/snippet}
{#snippet aiTurn()}<p class="sr-text">{p.result}</p>{/snippet}

<style>
  .sr-text { margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--fg); }
</style>
