<script lang="ts" module>
  import type { Client, AllergyEntry } from "./types";
  import { sortPinnedFirst } from "./pin-sort";
  import { rowAnchors } from "./anchor";

  export interface AllergyView { entry: AllergyEntry; anchor: string; result?: string }

  // W64 — anchors come from anchor.ts's rowAnchors, the one implementation. This file used to inline
  // its own copy under a comment calling it "a tiny pure helper, not worth forcing a shared import
  // across three call sites" — there were six, and the permalink resolver was one of them.
  export function buildAllergyRows(client: Client): AllergyView[] {
    const list = sortPinnedFirst(client.factors?.allergies ?? []);
    const anchors = rowAnchors(list.map((a) => a.allergen));
    const byId = new Map((client.finding?.allergyResults ?? []).map((r) => [r.allergyId, r.result] as const));
    return list.map((entry, i) => ({ entry, anchor: anchors[i], result: byId.get(entry.id) }));
  }
</script>

<script lang="ts">
  import TurnCard from "./TurnCard.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import FormGrid from "@tinytars/frame/FormGrid.svelte";
  import { openOnly } from "@tinytars/frame/LeafActionMenu.svelte";

  // M91 Phase 4 — the read-only search preview; Allergies.svelte's own row keeps the full CRUD menu
  // (Edit/Chat/Delete), which a preview has no business carrying.
  //
  // W64 — a TURN, not a bare card. It rendered plain spans while the section rendered a two-persona
  // TurnCard over the same entry, so the same allergy looked like a different kind of thing in
  // search — and the AI's read of it was missing entirely. Every sibling preview (StudyRow, NoteRow,
  // ThreadRow, TreatmentRow, ReportCell) is already a turn; these two were the last hold-outs, and
  // the comment blessing that cited ReportRow, which no longer exists.
  interface Props { view: AllergyView; onOpen?: () => void }
  let { view, onOpen }: Props = $props();
</script>

{#snippet patientTurn()}
  <FormGrid>
    <span class="field"><HeadingAnchor anchor={view.anchor} label="Copy link to this allergy">{view.entry.allergen || "Untitled"}</HeadingAnchor></span>
    <span class="field">{view.entry.reaction || "No reaction noted."}</span>
    <span class="field">{view.entry.severity || "—"}</span>
    <span class="field">{view.entry.dateNoted || "No date"}</span>
  </FormGrid>
{/snippet}
{#snippet aiTurn()}<p class="az-text">{view.result}</p>{/snippet}

<TurnCard items={openOnly(onOpen)} patient={patientTurn} ai={view.result ? aiTurn : undefined} />

<style>
  .az-text { margin: 0; font-size: 0.92rem; line-height: 1.5; color: var(--fg); white-space: pre-wrap; }
</style>
