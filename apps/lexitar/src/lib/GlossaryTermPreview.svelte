<script lang="ts">
  import type { Client } from "./types";
  import AiTurnCard from "./AiTurnCard.svelte";
  import { itemRecordId } from "@pablotech/akesi/item-registry";
  import { cellPin, type PinItem } from "./body-pin";

  // One glossary term as a leaf cell — the twin of QuestionPreview, converted for the same reason
  // (see its comment). The term heads the cell and the definition is LexiTar's turn, so the term is
  // both the visible title and the record key, matching termLeaf in the sidebar.
  interface Props {
    term: string;
    definition: string;
    anchor: string;
    onOpen?: () => void;
    client?: Client;
    onPin?: PinItem;
  }
  let { term, definition, anchor, onOpen, client, onPin }: Props = $props();

  const pin = $derived(client ? cellPin(client, "glossary", itemRecordId("glossary", term), onPin) : undefined);
</script>

<AiTurnCard {anchor} label={term} {onOpen} pinned={pin?.pinned} onTogglePin={pin?.onTogglePin}>
  <p class="gtp-def">{definition}</p>
</AiTurnCard>

<style>
  .gtp-def { margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--fg); }
</style>
