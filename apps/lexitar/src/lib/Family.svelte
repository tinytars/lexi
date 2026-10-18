<script lang="ts">
  import { createLeafTranslate } from "./leaf-translate.svelte";
  import { describeAiError } from "./ai-error";
  import type { Client, FamilyHistoryEntry, NoteAttachment, Attachment } from "./types";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import Modal from "@tinytars/frame/Modal.svelte";
  import Button from "@tinytars/frame/Button.svelte";
  import Field from "@tinytars/frame/Field.svelte";
  import FormGrid from "@tinytars/frame/FormGrid.svelte";
  import ModalActions from "@tinytars/frame/ModalActions.svelte";
  import SaveStatus from "@tinytars/frame/SaveStatus.svelte";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import { createDraftSync, createPersistNow } from "./draft-sync.svelte";
  import { conditionAnchor, rowAnchors } from "./anchor";
  import type { Permalink } from "./permalink";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";
  import TurnCard from "./TurnCard.svelte";
  import AttachmentStrip from "@tinytars/frame/AttachmentStrip.svelte";
  import { appendAttachments, attachmentUrl } from "./attachment-store";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import { sortPinnedFirst } from "./pin-sort";
  import { PRODUCT_NAME } from "./brand";

  // M65 — new Patient subsection for family history of disease (distinct from the patient's own
  // Conditions, which moved to its own Symptoms leaf in M94). Same draft/resync + modal-Add/Edit +
  // persistNow CRUD pattern as Allergies.svelte / the retired Personalization.svelte Correlations
  // block. M94 — gained an AI-paired column (finding.familyResults), mirroring Notes.svelte's
  // aiCol. M97 §C — familyResults gained a real leaf-regen-registry.ts entry; onTriggerRegen now
  // fires it.
  interface Props {
    client: Client;
    clientId?: string | null;
    onSave?: (updated: Client) => void;
    onSaved?: (anchor: string) => void;
    onTriggerRegen?: (key: string, targetLabels?: string[], force?: boolean) => Promise<{ status: "filled" | "empty" | "skipped" | "failed"; error?: string }>;
    saved?: boolean;
    saveError?: string | null;
    onStartChat?: (pl: Permalink) => void;
    // W46 — Annotate goes universal (was on 6 of ~12 leaf types); this leaf had neither the prop
    // nor a menu item for it.
    onCreateNote?: (attachment: NoteAttachment) => void;
    // M75 — a sidebar "+" navigated here and wants the Add modal opened automatically.
    autoOpenAdd?: boolean;
    onAutoOpenAddConsumed?: () => void;
    // Single-group by design (owner decision #3, M97 §E) — no natural subcategory field exists
    // for a family-history entry; the sidebar's one "Ungrouped" row is a selection anchor, not a
    // filtering gap.
  }
  let {
    client, clientId = null, onSave, onSaved, onTriggerRegen, saved = false, saveError = null,
    onStartChat, onCreateNote, autoOpenAdd = false, onAutoOpenAddConsumed,
  }: Props = $props();

  // The AI response for a given family-history entry id, read-only (generated, not authored).
  const aiById = $derived(new Map((client.finding?.familyResults ?? []).map((r) => [r.familyId, r] as const)));

  function build(c: Client): Client {
    const d = structuredClone($state.snapshot(c)) as Client;
    d.factors ??= {};
    d.factors.familyHistory ??= [];
    return d;
  }

  const ds = createDraftSync(() => client, build, () => saveError);
  const draft = $derived(ds.draft);

  // W63 — memoized, matching Allergies.svelte's `sortedAllergies`. It was called twice inline per
  // render AND, worse, the anchor below was computed against the UNSORTED array with an index taken
  // from this sorted one — so pinning any entry made every heading permalink point at a different
  // row. sortPinnedFirst preserves object identity, so indexOf against the draft array still works.
  const sortedFamily = $derived(sortPinnedFirst(draft.factors!.familyHistory!));

  // M66 P4 — row anchors reuse conditionAnchor(relation), disambiguated by the row's own index only
  // on a collision. W64 — one shared implementation (anchor.ts's rowAnchors); it existed six times,
  // including in the permalink RESOLVER, which has to agree with what is rendered here.
  const anchors = $derived(rowAnchors(sortedFamily.map((x) => x.relation)));


  const persistNow = createPersistNow(ds, () => client, onSave, onSaved);

  let addOpen = $state(false);
  let newEntry = $state<FamilyHistoryEntry | null>(null);
  // W63 — the row being edited, by ID not by index. It was the index of the row in the SORTED
  // view, applied to the UNSORTED draft array: with anything pinned, Edit overwrote a different
  // entry and Delete removed a different entry, silently. toggleEntryPin below already matched by
  // id, with a comment saying exactly why ("a row's index can shift under filtering/reordering") —
  // the rest of the file did not follow it.
  let editId = $state<string | null>(null);
  function openAdd() {
    newEntry = { id: crypto.randomUUID(), relation: "", condition: "" };
    editId = null;
    addOpen = true;
  }
  $effect(() => {
    if (autoOpenAdd) {
      openAdd();
      onAutoOpenAddConsumed?.();
    }
  });
  function openEdit(f: FamilyHistoryEntry) {
    newEntry = { ...f };
    editId = f.id;
    addOpen = true;
  }
  function cancelAdd() {
    addOpen = false;
    newEntry = null;
    editId = null;
  }
  function saveNewEntry() {
    if (!newEntry || !newEntry.relation.trim() || !newEntry.condition.trim()) return;
    if (editId !== null) {
      const id = editId;
      const edited = { ...newEntry };
      // Write by id, and APPEND when the id is absent rather than skip. persistNow's payload is a
      // clone of the last-SAVED client (draft-sync.ts:71), so an entry added seconds ago may not be
      // in it yet — the index-based version this replaced happened to append in that case (its
      // index equalled the array length) and dropping the write instead lost the edit outright.
      //
      // W64 / #99 — the append would ALSO decide a collision: if this entry were deleted elsewhere
      // while its modal is open, Save brings it back rather than discarding what was typed (owner
      // call, 2026-08-22: the user typed and pressed Save). That path is currently UNREACHABLE and
      // there is deliberately no test for it — Modal.svelte's backdrop is `position: fixed; inset: 0`
      // with onclick=onClose, so any click toward the sidebar closes the modal before it can delete
      // anything; measured with elementFromPoint. Two things would make it reachable and bring the
      // choice above back into play: a live cross-session vault sync, or a delete affordance that
      // does not require a click outside the modal.
      const put = (list: FamilyHistoryEntry[]) => {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list[i] = edited; else list.push(edited);
      };
      put(draft.factors!.familyHistory!);
      persistNow((p) => {
        p.factors ??= {};
        p.factors.familyHistory ??= [];
        put(p.factors.familyHistory);
      }, conditionAnchor(edited.relation));
    } else {
      draft.factors!.familyHistory!.push(newEntry);
      persistNow((p) => {
        p.factors ??= {};
        p.factors.familyHistory ??= [];
        p.factors.familyHistory.push(newEntry!);
      }, conditionAnchor(newEntry.relation));
    }
    onTriggerRegen?.("familyResults");
    addOpen = false;
    newEntry = null;
    editId = null;
  }
  function deleteEntry(f: FamilyHistoryEntry) {
    if (!confirm(`Remove ${f.relation ? `“${f.relation}”` : "this entry"}? This can't be undone.`)) return;
    const drop = (list: FamilyHistoryEntry[]) => {
      const i = list.findIndex((x) => x.id === f.id);
      if (i >= 0) list.splice(i, 1);
    };
    drop(draft.factors!.familyHistory!);
    persistNow((p) => drop(p.factors!.familyHistory!), "family-history-list");
  }

  // M71 P6 — standalone Pin toggle, same clone-mutate-persist shape as toggleWatchlist (App.svelte:1071-1078),
  // matched by id since a row's index can shift under filtering/reordering.
  // W64 — compute the new value ONCE and write it to both. Each side used to flip its own copy
  // (`!m.pinned`), so a payload whose `pinned` disagreed with the draft's flipped the opposite way
  // and the pin came back from the save inverted.
  function toggleEntryPin(f: FamilyHistoryEntry) {
    const next = !f.pinned;
    const match = draft.factors!.familyHistory!.find((x) => x.id === f.id);
    if (match) match.pinned = next;
    persistNow((p) => {
      const m = p.factors?.familyHistory?.find((x) => x.id === f.id);
      if (m) m.pinned = next;
    }, "family-history-list");
  }

  function buildAttachment(f: FamilyHistoryEntry, i: number): NoteAttachment {
    return buildNoteAttachment(
      "family",
      { client: clientId ?? undefined, tab: "doctor", section: "familyHistory", anchor: anchors[i] },
      { title: f.relation || "Family history", subtitle: f.condition, tag: "Family" },
    );
  }

  let attachError = $state<string | null>(null);
  function attachToFamily(f: FamilyHistoryEntry, added: Attachment[]) {
    const match = draft.factors!.familyHistory!.find((x) => x.id === f.id);
    if (match) match.attachments = appendAttachments(match.attachments, added);
    persistNow((p) => {
      const m = p.factors!.familyHistory!.find((x) => x.id === f.id);
      if (m) m.attachments = appendAttachments(m.attachments, added);
    });
  }

  // Translate is leaf-specific (like Markers' — see MarkerChart.svelte's rowActions, and
  // UnifiedTreatment.svelte's Treatment rows), so it's prepended manually rather than living in the
  // shared standardLeafActions contract. Scoped to just this entry (targetIds: [f.id]) — see
  // leaf-regen-specs/id-rows.ts's familyResults spec. force:true bypasses the staleness gate so the
  // click always fires; stays visible even when a result already exists so a provider can force a
  // re-check.
  // W64 — one implementation, in leaf-translate.svelte.ts. This block was byte-identical across
  // Notes/Study/Allergies/Family, comment included.
  const tr = createLeafTranslate(() => onTriggerRegen);
  const doTranslate = (f: FamilyHistoryEntry) => tr.run(f.id, "familyResults", [f.id]);


  // W46 Phase 2/4 — canonical Edit → Chat → Annotate → Attach → Delete order via the shared
  // leaf-actions contract (was a hand-rolled array, no Annotate/Attach).
  function rowActions(f: FamilyHistoryEntry, i: number): LeafMenuItem[] {
    return [
      {
        key: "translate",
        label: tr.translatingId === f.id ? "Translating…" : "Translate",
        title: "Translate",
        disabled: tr.translatingId === f.id,
        onClick: () => doTranslate(f),
      },
      ...standardLeafActions({
        edit: () => openEdit(f),
        chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "doctor", section: "familyHistory", anchor: anchors[i] }),
        annotate: onCreateNote ? () => onCreateNote!(buildAttachment(f, i)) : undefined,
        attach: clientId ? { clientId, onAttached: (added) => attachToFamily(f, added), onError: (msg) => (attachError = msg) } : undefined,
        delete: () => deleteEntry(f),
      }),
    ];
  }
</script>

<div class="family leaf-section">
  <div class="fh-editbar">
    <div class="fh-title">
      <SaveStatus {saved} />
    </div>
  </div>
  <SaveStatus error={saveError} />
  <SaveStatus error={attachError} />
  <SaveStatus error={tr.translateError} />

  <section class="fh-block" id="family-history-list">
    {#if sortedFamily.length === 0}
      <p class="leaf-empty">No family history yet — add one from the sidebar.</p>
    {:else}
      {#each sortedFamily as f, i (f.id)}
        {@const result = aiById.get(f.id)?.result}
        {#snippet num()}<span class="entry-num">#{i + 1}</span>{/snippet}
        {#snippet patientTurn()}
          <FormGrid>
            <span class="field"><HeadingAnchor anchor={anchors[i]} label="Copy link to this family history entry">{f.relation || "Untitled"}</HeadingAnchor></span>
            <span class="field">{f.condition || "No condition noted."}</span>
          </FormGrid>
          <AttachmentStrip attachments={f.attachments ?? []} {clientId} {attachmentUrl} productName={PRODUCT_NAME} />
        {/snippet}
        {#snippet aiTurn()}<p class="fh-text">{result}</p>{/snippet}
        <TurnCard
          titleContent={num}
          items={rowActions(f, i)}
          pinned={!!f.pinned}
          onTogglePin={() => toggleEntryPin(f)}
          patient={patientTurn}
          ai={result ? aiTurn : undefined}
        />
      {/each}
    {/if}
  </section>
</div>

{#if addOpen && newEntry}
  <Modal label={editId === null ? "Add family history" : "Edit family history"} onClose={cancelAdd} snapshot={() => newEntry}>
    <div class="fh-modal">
      <Field label="Relation">
        <div class="field-row">
          <input type="text" placeholder="e.g. Mother" bind:value={newEntry.relation} />
          <DictateButton onResult={(t) => (newEntry!.relation = newEntry!.relation ? `${newEntry!.relation} ${t}` : t)} />
        </div>
      </Field>
      <Field label="Condition">
        <div class="field-row">
          <input type="text" placeholder="e.g. Type 2 diabetes" bind:value={newEntry.condition} />
          <DictateButton onResult={(t) => (newEntry!.condition = newEntry!.condition ? `${newEntry!.condition} ${t}` : t)} />
        </div>
      </Field>
      <ModalActions>
        <Button onclick={cancelAdd}>Cancel</Button>
        <Button primary onclick={saveNewEntry} disabled={!newEntry.relation.trim() || !newEntry.condition.trim()}>Save</Button>
      </ModalActions>
    </div>
  </Modal>
{/if}

<style>
  input {
    font: inherit; font-size: 0.95rem; color: var(--fg);
    padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: white; width: 100%; box-sizing: border-box;
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--band); }

  .entry-num { font-size: 0.78rem; color: var(--muted); font-weight: 600; }

  .fh-text { margin: 0; font-size: 0.92rem; line-height: 1.5; color: var(--fg); white-space: pre-wrap; }


  @media print { .family { display: none !important; } }
</style>
