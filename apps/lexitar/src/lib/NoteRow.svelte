<script lang="ts">
  import type { NotePair } from "./note-pairs";
  import TurnCard from "./TurnCard.svelte";
  import ReferenceCard from "./ReferenceCard.svelte";
  import { noteAnchor } from "./anchor";
  import type { Permalink } from "./permalink";

  // M91 Phase 3 — the read-only/search twin of Notes.svelte's editable row.
  // M92 Phase 8 — takes a NotePair (note text + AI result), not a bare NoteEntry, mirroring
  // StudyRow's two-column patient/AI pattern. No title: unlike Study, a note has no short
  // hand-picked focus label to head the card with — which is why TurnCard's title is optional.
  interface Props { pair: NotePair; onOpen?: () => void; onNavigate?: (patch: Partial<Permalink>) => void }
  let { pair: p, onOpen, onNavigate }: Props = $props();
</script>

<TurnCard
  anchor={noteAnchor(p.id)}
  {onOpen}
  patient={p.text ? patientTurn : undefined}
  patientAfter={p.text && p.attachment ? reference : undefined}
  ai={p.result ? aiTurn : undefined}
  patientEmpty="No note on file."
/>

{#snippet patientTurn()}<p class="note-text">{p.text}</p>{/snippet}
{#snippet reference()}<ReferenceCard reference={p.attachment!} {onNavigate} />{/snippet}
{#snippet aiTurn()}<p class="note-text">{p.result}</p>{/snippet}

<style>
  .note-text { margin: 0; font-size: 0.92rem; line-height: 1.5; color: var(--fg); white-space: pre-wrap; }
</style>
