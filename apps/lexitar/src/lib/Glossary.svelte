<script lang="ts">
  import type { Client } from "./types";
  import GlossaryTermPreview from "./GlossaryTermPreview.svelte";
  import type { PinItem } from "./body-pin";
  import { termAnchor } from "./anchor";
  import { systemOrder, UNCATEGORIZED } from "@pablotech/akesi-pil/system-groups";
  import { filterByGroup } from "@tinytars/frame/group-filter";
  import { ALL_GROUP_KEY } from "./sidebar-labels";

  // W24 — Glossary (finding.definitions) as a screen section (was PDF-only): the terms and
  // abbreviations used across the report, expanded.
  // M96 Phase 10 — one GlossaryTermPreview per term (was the whole list in one shared PersonaBubble),
  // filtered by the sidebar's Ungrouped/body-system selection — same reuse pattern as Phase 8's
  // QuestionsForDr rewrite. Unlike Questions, definitions[].group is a real body-system value
  // (Phase 9's validator ties it to disease[].group), so terms are bucketed via systemOrder/
  // UNCATEGORIZED instead of a topic-derived key.
  interface Props {
    client: Client;
    activeGroup?: string | null;
    onPin?: PinItem;
  }
  let { client, activeGroup = $bindable(null), onPin }: Props = $props();

  const defs = $derived(client.finding?.definitions ?? []);
  const order = $derived(systemOrder(client));
  const terms = $derived(
    defs.map((d) => ({
      term: d.term,
      definition: d.definition,
      system: d.group && order.includes(d.group) ? d.group : UNCATEGORIZED,
      anchorId: termAnchor(d.term),
    })),
  );
  // "system:"+system keys mirror glossary-sidebar-groups.ts's convention, under the shared rule in
  // group-filter.ts: All shows everything, a named system shows exactly its own terms. Inert for
  // the same reason QuestionsForDr's is — see the longer note there.
  const visible = $derived(filterByGroup(terms, activeGroup, (t) => "system:" + t.system, ALL_GROUP_KEY));
</script>

<div class="glossary leaf-section">
  {#if terms.length === 0}
    <p class="leaf-empty">No glossary on file for {client.displayName}.</p>
  {:else if visible.length === 0}
    <p class="leaf-empty">No glossary terms for this system.</p>
  {:else}
    <div class="gl-list">
      {#each visible as t (t.anchorId)}
        <GlossaryTermPreview term={t.term} definition={t.definition} anchor={t.anchorId} {client} {onPin} />
      {/each}
    </div>
  {/if}
</div>

<style>
</style>
