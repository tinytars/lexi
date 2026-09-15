<script lang="ts">
  import AiTurnCard from "./AiTurnCard.svelte";
  import type { Client } from "./types";
  import type { ExplorationTuple } from "./exploration-rows";
  import { itemRecordId } from "@pablotech/akesi/item-registry";
  import { cellPin, type PinItem } from "./body-pin";

  // One exploration item as a leaf cell. The shape itself lives in AiTurnCard, shared with Analysis.
  interface Props { tuple: ExplorationTuple; onOpen?: () => void; client?: Client; onPin?: PinItem }
  let { tuple, onOpen, client, onPin }: Props = $props();

  // The item's TEXT is the key, matching explorationItemLeaf in the sidebar — the anchor's index is
  // positional and the next Finding renumbers it.
  const pin = $derived(client ? cellPin(client, "exploration", itemRecordId("exploration", tuple.text), onPin) : undefined);
</script>

<AiTurnCard
  anchor={tuple.anchor}
  label={tuple.type}
  tag={tuple.side === "dueSoon" ? "Due soon" : undefined}
  {onOpen}
  pinned={pin?.pinned}
  onTogglePin={pin?.onTogglePin}
>
  <p class="tc-text">{tuple.text}</p>
</AiTurnCard>

<style>
  .tc-text { margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--fg); }
</style>
