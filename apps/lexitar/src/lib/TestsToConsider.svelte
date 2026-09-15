<script lang="ts">
  import type { Client } from "./types";
  import ExplorationCell from "./ExplorationCell.svelte";
  import type { PinItem } from "./body-pin";
  import { buildExplorationRows } from "./exploration-rows";
  import { groupBySystem } from "@pablotech/akesi/system-groups";
  import { explorationAnchor, findByAnchor } from "./anchor";
  import { filterByGroup } from "@tinytars/frame/group-filter";
  import { ALL_GROUP_KEY } from "./sidebar-labels";

  // W22 — "Test to Consider" (was Data Requisition), moved into AI Thoughts, in the persona visual
  // language. finding.dataRequisition = additional data to obtain. W27 — grouped by body system (System
  // Analysis order) THEN by modality; one AI bubble per (modality × system) cell, topic = type, a list of
  // the tests. Items may carry a [new]/[overdue]/[due soon] tag. Pre-W27 Findings carry no `group`, so
  // fall back to the flat modality list. M80 — promoted to its own top-level "Exploration" subsection
  // with Markers-style single-active-group rendering (was: every system stacked on one page).
  interface Props {
    client: Client;
    // M80 — which sidebar body-system group is selected; the page renders exactly that one system's
    // cells instead of every system stacked. Bindable so the pendingAnchor reverse-match effect below
    // can switch it.
    activeGroup?: string | null;
    // A deep-linked anchor whose owning system may not be the currently active one; reverse-matched
    // against the full entries below, then cleared via onConsumeAnchor.
    pendingAnchor?: string | null;
    onConsumeAnchor?: () => void;
    onPin?: PinItem;
  }
  let {
    client,
    activeGroup = $bindable(null), pendingAnchor = null, onConsumeAnchor, onPin,
  }: Props = $props();

  // "Due soon" items are lower-priority and clutter the list, so they collapse behind an expander;
  // new/overdue/untagged tests show immediately.
  const allEntries = $derived(buildExplorationRows(client));
  // W27 — group the modality cells under body-system headings (System Analysis order). Pre-W27 Findings
  // carry no `group` on any entry, so fall back to the flat modality list (grouped=null).
  const bySystem = $derived.by(() => (allEntries.some((e) => e.group) ? groupBySystem(client, allEntries, (e) => e.group) : null));

  // M80 — which single body system's cells render. Trusts activeGroup when it names a system present
  // in `bySystem`; otherwise defaults to the first group's system (or null if `bySystem` is null/empty),
  // mirroring FutureTreatment.svelte's resolvedGroup exactly.
  // W61 — the one shared rule (group-filter.ts): All shows every system, a named system shows only
  // its own cells, and an empty system renders empty instead of falling back to the first one's.
  const shownRows = $derived(
    bySystem ? filterByGroup(bySystem, activeGroup, (g) => g.system, ALL_GROUP_KEY).flatMap((g) => g.rows) : [],
  );

  // A deep-linked exploration anchor whose owning system isn't the currently active one would
  // otherwise never mount under single-system rendering. Reverse-match it against `bySystem`, switch
  // to its owning system, then let the caller clear pendingAnchor. M103 — a search result now links
  // to an item-level anchor (explorationItemAnchor), which never strictly equals the cell-level
  // explorationAnchor; startsWith fallback mirrors FutureTreatment.svelte's identical ideaAnchor fix.
  $effect(() => {
    if (!pendingAnchor || !bySystem) return;
    const match = bySystem.find((g) => !!findByAnchor(g.rows, pendingAnchor, (r) => explorationAnchor(r.group, r.type)));
    if (match) {
      activeGroup = match.system;
      onConsumeAnchor?.();
    }
  });
</script>

<div class="tests-consider leaf-section">
  {#if allEntries.length === 0}
    <p class="leaf-empty">No further tests suggested for {client.displayName}.</p>
  {:else}
    {#if bySystem}
      {#if shownRows.length}
        <div class="tc-list">
          {#each shownRows as g, i (i)}<ExplorationCell req={g} {client} {onPin} />{/each}
        </div>
      {:else}
        <p class="leaf-empty">No further tests suggested for this system.</p>
      {/if}
    {:else}
      <div class="tc-list">
        {#each allEntries as g, i (i)}<ExplorationCell req={g} {client} {onPin} />{/each}
      </div>
    {/if}
  {/if}
</div>

<style></style>
