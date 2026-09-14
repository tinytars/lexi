<script lang="ts">
  import type { Client } from "./types";
  import AnalysisBlock from "./AnalysisBlock.svelte";
  import { ANALYSIS_NAV } from "./analysis-nav";
  import { filterByGroup } from "@tinytars/frame/group-filter";
  import { analysisItems } from "./analysis-items";
  import { analysisItemsFor } from "./analysis-items";
  import type { PinItem } from "./body-pin";
  import { ALL_GROUP_KEY } from "./sidebar-labels";

  // W34 — the consolidated analytical read: the former Health Progression, System Analysis, AI Conclusion
  // sub-tabs stacked as one subsection (distinct titled blocks), provider-only. Study and Exploration
  // moved out to their own subsections. M80 — AI Conclusion's 3 children (Pattern & Anti-pattern,
  // Clinical Synthesis, Final Thoughts) flattened to top-level blocks so each gets its own sidebar nav
  // row (ANALYSIS_NAV, shared with Sidebar.svelte's leaf-list so the two can't drift apart).
  interface Props {
    client: Client;
    // W61 — Analysis takes the sidebar's group like every other section. It used to take none: its
    // rows only scrolled, so selecting "On Treatment" left all six blocks on screen and the click
    // looked ignored. All shows every block; a named block shows only itself.
    activeGroup?: string | null;
    // W62 — the selected CHILD row (one LexiTar turn). Its rows are this section's cells one-for-one,
    // so selecting one narrows to that turn instead of merely scrolling to it.
    activeLeaf?: string | null;
    onPin?: PinItem;
  }
  let { client, activeGroup = null, activeLeaf = null, onPin }: Props = $props();

  // A child row's key is the item's anchor (analysisSidebarGroups), so the selected turn identifies
  // its own block — no second mapping from row to section to keep in step.
  const selected = $derived(activeLeaf ? analysisItems(client).find((i) => i.anchor === activeLeaf) : undefined);
  const shown = $derived(
    selected
      ? ANALYSIS_NAV.filter((n) => n.key === selected.section)
      : filterByGroup(ANALYSIS_NAV, activeGroup, (n) => n.key, ALL_GROUP_KEY),
  );
  const allEmpty = $derived(shown.every((n) => analysisItemsFor(client, n.key).length === 0));
</script>

<div class="analysis leaf-section">
  {#if shown.length === 0}
    <p class="leaf-empty">Nothing in this section of the analysis.</p>
  {:else if allEmpty}
    <!-- W63 — one empty state, not seven. Every AnalysisBlock renders its own "No X on file" line,
         so when the whole section is empty this used to paint the aggregate message AND one line
         per block. Skip the blocks entirely in that case rather than stack the two. -->
    <p class="leaf-empty">No analysis on file for {client.displayName} here yet.</p>
  {:else}
    {#each shown as nav (nav.key)}
      <!-- The block's anchor lives on the section itself now: the heading that used to carry it sat
           outside the leaf card, which no other section does, and repeated the cell's own title for
           the single-item blocks. Each cell carries its own HeadingAnchor, so per-item permalinks are
           unaffected, and the sidebar names the block. -->
      <section class="an-block" id={nav.anchor}>
        <AnalysisBlock section={nav.key} {client} {activeLeaf} {onPin} />
      </section>
    {/each}
  {/if}
</div>

<style>
  .an-block { margin-bottom: 2.25rem; }
  .an-block:last-child { margin-bottom: 0; }
</style>
