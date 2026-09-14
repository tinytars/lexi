<script lang="ts">
  import type { Req } from "./exploration-rows";
  import { tuplesOf } from "./exploration-rows";
  import ExplorationItemCard from "./ExplorationItemCard.svelte";
  import type { Client } from "./types";
  import type { PinItem } from "./body-pin";

  // One (system, modality) requisition, rendered as ONE CELL PER ITEM.
  //
  // It used to be a single AI bubble with the items as <li>s, which is why an exploration item was
  // the only thing in the app listed in the sidebar without being a leaf of its own. Now each item
  // is an ExplorationItemCard — the same LeafCard/persona shape Study and Hypothesis use — so it
  // is addressable, actionable, and has somewhere for a per-item record to live.
  //
  // `only` (search preview) still scopes the render to exactly one item; `onOpen` is still the
  // search-only "Open" action. Both contracts are unchanged for callers.
  interface Props {
    req: Req; onOpen?: () => void; only?: { side: "items" | "dueSoon"; index: number };
    client?: Client; onPin?: PinItem;
  }
  let { req, onOpen, only, client, onPin }: Props = $props();

  let tuples = $derived(
    tuplesOf(req).filter((t) => !only || (t.side === only.side && t.index === only.index)),
  );
</script>

{#each tuples as t (t.anchor)}
  <ExplorationItemCard tuple={t} {onOpen} {client} {onPin} />
{/each}
