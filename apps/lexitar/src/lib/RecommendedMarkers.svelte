<script lang="ts">
  import type { Client } from "./types";
  import AiTurnCard from "./AiTurnCard.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import { healthMarkersAnchor, healthMarkersGroupAnchor } from "./anchor";
  import { recommendedMarkerGroups } from "./recommended-markers-sidebar-groups";
  import { itemRecordId } from "@pablotech/akesi/item-registry";
  import { cellPin, type PinItem } from "./body-pin";
  import { filterByLeaf } from "@tinytars/frame/group-filter";

  // M97 §F — finding.healthMarkers.recommended had been generated and validated by every full
  // Finding regen since it was added while nothing rendered it; the first pass landed it at the
  // bottom of Investigator as plain AI bubbles, explicitly deferring shape/UX.
  // W61 — this is that follow-up. It moved under Notes (between Questions and Glossary) and each
  // body-system group is now a turn cell: LexiTar proposing markers to track, unprompted, so the
  // patient half renders as the same "not asked" empty state Exploration and Analysis use.
  interface Props {
    client: Client;
    // W62 — this section has ONE group row (All) whose children are its cells, so the thing that
    // filters it is the selected CHILD, not a group key. It used to declare activeGroup and then
    // destructure without it, so every system's row click fell through to a scroll — the page never
    // changed and the click read as ignored.
    activeLeaf?: string | null;
    onPin?: PinItem;
  }
  let { client, activeLeaf = null, onPin }: Props = $props();

  // The child row's key IS the body-system group name (recommendedMarkerLeaf), so they compare directly.
  const groups = $derived(filterByLeaf(recommendedMarkerGroups(client), activeLeaf, (g) => g.group));
</script>

<div class="recommended-markers leaf-section">
  {#if groups.length === 0}
    <p class="leaf-empty">No recommended-marker read on file for {client.displayName}.</p>
  {:else}
    {#each groups as g, i (g.group ?? i)}
      {#snippet markerList()}
        <ul class="rm-items">
          {#each g.markers as m, j (m.name ?? j)}
            <li>
              <HeadingAnchor anchor={healthMarkersAnchor(g.group, m.name)} label={"Copy link to " + m.name}>
                <span class="rm-name">{m.name}</span>
              </HeadingAnchor>
              <p class="rm-rationale">{m.rationale}</p>
            </li>
          {/each}
        </ul>
      {/snippet}
      {@const pin = cellPin(client, "recommendedMarkers", itemRecordId("recommendedMarkers", g.group), onPin)}
      <AiTurnCard anchor={healthMarkersGroupAnchor(g.group)} label={g.group} pinned={pin?.pinned} onTogglePin={pin?.onTogglePin}>
        {@render markerList()}
      </AiTurnCard>
    {/each}
  {/if}
</div>

<style>
  .rm-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .rm-name { font-size: 0.9rem; font-weight: 600; color: var(--fg); }
  .rm-rationale { margin: 0.2rem 0 0; font-size: 0.88rem; line-height: 1.5; color: var(--fg); }
  @media print { .recommended-markers { break-inside: avoid; } }
</style>
