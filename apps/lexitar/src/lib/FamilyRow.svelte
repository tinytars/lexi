<script lang="ts" module>
  import type { Client, FamilyHistoryEntry } from "./types";
  import { sortPinnedFirst } from "./pin-sort";
  import { rowAnchors } from "./anchor";

  export interface FamilyView { entry: FamilyHistoryEntry; anchor: string; result?: string }

  // W64 — anchors from anchor.ts's rowAnchors, the one implementation (see AllergyRow for the count).
  export function buildFamilyRows(client: Client): FamilyView[] {
    const list = sortPinnedFirst(client.factors?.familyHistory ?? []);
    const anchors = rowAnchors(list.map((f) => f.relation));
    const byId = new Map((client.finding?.familyResults ?? []).map((r) => [r.familyId, r.result] as const));
    return list.map((entry, i) => ({ entry, anchor: anchors[i], result: byId.get(entry.id) }));
  }
</script>

<script lang="ts">
  import TurnCard from "./TurnCard.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import FormGrid from "@tinytars/frame/FormGrid.svelte";
  import { openOnly } from "@tinytars/frame/LeafActionMenu.svelte";

  // M91 Phase 4 — the read-only search preview; Family.svelte's own row keeps the full CRUD menu.
  // W64 — a TURN, not a bare card, for the reason spelled out in AllergyRow.svelte.
  interface Props { view: FamilyView; onOpen?: () => void }
  let { view, onOpen }: Props = $props();
</script>

{#snippet patientTurn()}
  <FormGrid>
    <span class="field"><HeadingAnchor anchor={view.anchor} label="Copy link to this family history entry">{view.entry.relation || "Untitled"}</HeadingAnchor></span>
    <span class="field">{view.entry.condition || "No condition noted."}</span>
  </FormGrid>
{/snippet}
{#snippet aiTurn()}<p class="fh-text">{view.result}</p>{/snippet}

<TurnCard items={openOnly(onOpen)} patient={patientTurn} ai={view.result ? aiTurn : undefined} />

<style>
  .fh-text { margin: 0; font-size: 0.92rem; line-height: 1.5; color: var(--fg); white-space: pre-wrap; }
</style>
