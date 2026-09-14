<script lang="ts">
  import type { Client } from "./types";
  import AiTurnCard from "./AiTurnCard.svelte";
  import { itemRecordId } from "@pablotech/akesi-pil/item-registry";
  import { cellPin, type PinItem } from "./body-pin";

  // One doctor question as a leaf cell.
  //
  // M91 Phase 5 introduced this at the SINGLE-QUESTION granularity (owner-locked ruling: the group
  // is a sidebar-organizational bucket, not the leaf). W62 gives it the turn-cell treatment the rest
  // of the app already had — it and GlossaryTermPreview were the last two sections rendering a bare
  // PersonaBubble, which is why their records were reachable from the sidebar and nowhere else:
  // no LeafCard means nowhere for a ★ or a row menu to live.
  //
  // The patient half renders as "not asked" (AiTurnCard) and that is exactly right here: these are
  // questions LexiTar raises FOR the doctor, never answers to something the patient asked.
  interface Props {
    group: string;
    question: string;
    anchor: string;
    onOpen?: () => void;
    client?: Client;
    onPin?: PinItem;
  }
  let { group, question, anchor, onOpen, client, onPin }: Props = $props();

  // Keyed on the FULL question text, matching questionLeaf in the sidebar — the anchor's index is
  // positional and the next Finding renumbers it.
  const pin = $derived(client ? cellPin(client, "question", itemRecordId("question", question), onPin) : undefined);
</script>

<AiTurnCard {anchor} label={group} {onOpen} pinned={pin?.pinned} onTogglePin={pin?.onTogglePin}>
  <p class="qp-question">{question}</p>
</AiTurnCard>

<style>
  .qp-question { margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--fg); }
</style>
