<script lang="ts">
  import type { Client } from "./types";
  import QuestionPreview from "./QuestionPreview.svelte";
  import type { PinItem } from "./body-pin";
  import { filterByGroup } from "@tinytars/frame/group-filter";
  import { questionItems } from "./question-items";
  import { ALL_GROUP_KEY } from "./sidebar-labels";

  // W22 — "Questions for Dr" (was AI Inference Conversation) in the persona visual language. These are
  // the finding-based doctorConversation groups — the leading slice, which since W76 is taken in one
  // place (doctor-conversation.ts) rather than restated by each reader.
  // M96 Phase 8 — one QuestionPreview per individual question (was one PersonaBubble per group
  // containing every sibling question), filtered by the sidebar's Ungrouped/topic selection.
  interface Props {
    client: Client;
    activeGroup?: string | null;
    onPin?: PinItem;
  }
  let { client, activeGroup = $bindable(null), onPin }: Props = $props();

  // W63 — one derivation, in question-items.ts, shared with the sidebar builder and search. It was
  // three copies: this one and questions-sidebar-groups.ts were verbatim identical (this comment
  // used to say so), and search-index.ts had drifted into indexing groups this page never renders.
  // Pinned-first comes with it — the sidebar's All row already sorted that way and this did not, so
  // pinning a question moved its row and left its cell in place.
  const questions = $derived(questionItems(client));
  // "topic:"+group keys mirror questions-sidebar-groups.ts's convention. The shared rule (see
  // group-filter.ts): All shows everything, a named topic shows exactly its own questions — an
  // empty topic renders empty rather than falling back to the whole list, which read as the click
  // having been ignored.
  //
  // Inert as the app stands: W61 made Questions a group row UNDER Notes, so `active` is never
  // "docInference", Sidebar's lowerZoneKind never becomes "questions", and the only mount
  // (ReportSections' notes branch) hardcodes activeGroup="ungrouped". questionsSidebarGroups' topic
  // rows are unreachable with it — only its All row's children are read, by sidebar-leaf-rows.
  // Kept on the shared rule so it is right if that path revives, rather than right by accident.
  const visible = $derived(filterByGroup(questions, activeGroup, (q) => "topic:" + q.group, ALL_GROUP_KEY));
</script>

<div class="questions-dr leaf-section">
  {#if questions.length === 0}
    <p class="leaf-empty">No doctor questions on file for {client.displayName}.</p>
  {:else if visible.length === 0}
    <p class="leaf-empty">No questions for this topic.</p>
  {:else}
    <div class="qd-list">
      {#each visible as q (q.anchor)}
        <QuestionPreview group={q.group} question={q.question} anchor={q.anchor} {client} {onPin} />
      {/each}
    </div>
  {/if}
</div>

<style>
</style>
