<script lang="ts">
  import { createLeafTranslate } from "./leaf-translate.svelte";
  import { describeAiError } from "./ai-error";
  import type { Client, NoteEntry, NoteAttachment, Attachment } from "./types";
  import Modal from "@tinytars/frame/Modal.svelte";
  import Button from "@tinytars/frame/Button.svelte";
  import Field from "@tinytars/frame/Field.svelte";
  import ModalActions from "@tinytars/frame/ModalActions.svelte";
  import SaveStatus from "@tinytars/frame/SaveStatus.svelte";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import TurnCard from "./TurnCard.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";
  import { createDraftSync, createPersistNow } from "./draft-sync.svelte";
  import type { Permalink } from "./permalink";
  import { sortPinnedFirst } from "./pin-sort";
  import { noteAnchor } from "./anchor";
  import NoteRow from "./NoteRow.svelte";
  import { buildNotePairs } from "./note-pairs";
  import { PRODUCT_NAME } from "./brand";
  import ReferenceCard from "./ReferenceCard.svelte";
  import AttachmentStrip from "@tinytars/frame/AttachmentStrip.svelte";
  import { appendAttachments, attachmentUrl } from "./attachment-store";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";

  // M63 — a flat, reorderable list of free-text notes (one text box per entry, no title/date).
  // Mirrors FutureTreatment/Study's draft+resync+per-row-edit CRUD, minus the filter (list stays
  // short) and plus move-up/move-down (no precedent elsewhere in the app — order is the array index).
  // M92 Phase 8 — Notes is now a real AI-paired leaf (finding.noteResults, mirroring Study's
  // studyResults): each row shows the note beside the AI's response, LeafCard/PersonaBubble style.
  interface Props {
    client: Client;
    clientId?: string | null;
    onSave?: (updated: Client) => void;
    // M66 P4 — fires with the anchor of the item just saved/deleted, mirroring Study/Treatment.
    onSaved?: (anchor: string) => void;
    // M66 P7 — requests an immediate noteResults regen right after a save, instead of waiting on the
    // shell's own background staleness effect. Always unscoped (no targetLabels) — a note has no
    // label to scope by the way Study's row-scoped regen does; see leaf-regen-registry.ts's
    // noteResults entry.
    onTriggerRegen?: (key: string, targetLabels?: string[], force?: boolean) => Promise<{ status: "filled" | "empty" | "skipped" | "failed"; error?: string }>;
    saved?: boolean;
    saveError?: string | null;
    onStartChat?: (pl: Permalink) => void;
    // W46 — Annotate goes universal: a note can now itself be annotated (a note about a note),
    // mirroring every other leaf's onCreateNote wiring (see ChatTab/Study/MarkerChart precedent).
    onCreateNote?: (attachment: NoteAttachment) => void;
    // M75 — a sidebar "+" navigated here and wants the Add modal opened automatically.
    autoOpenAdd?: boolean;
    onAutoOpenAddConsumed?: () => void;
    // M-chat-file-attach-and-create-note — a chat turn arrived here to seed a new note.
    pendingAttachment?: NoteAttachment | null;
    onPendingAttachmentConsumed?: () => void;
    onNavigate?: (patch: Partial<Permalink>) => void;
    // Single-group by design (owner decision #3, M97 §E) — no natural subcategory field exists
    // for a note; the sidebar's one "Ungrouped" row is a selection anchor, not a filtering gap.
  }
  let {
    client, clientId = null, onSave, onSaved, onTriggerRegen, saved = false, saveError = null,
    onStartChat, onCreateNote, autoOpenAdd = false, onAutoOpenAddConsumed,
    pendingAttachment = null, onPendingAttachmentConsumed, onNavigate,
  }: Props = $props();

  const canEdit = $derived(!!onSave);

  // Read-only pairing (patient view): note rows ↔ AI results.
  const pairs = $derived(buildNotePairs(client));
  // The AI response for a given note id — read-only in both views (it's generated, not authored).
  const aiById = $derived(new Map((client.finding?.noteResults ?? []).map((r) => [r.noteId, r] as const)));

  function build(c: Client): Client {
    const d = structuredClone($state.snapshot(c)) as Client;
    d.factors ??= {};
    d.factors.noteEntries ??= [];
    return d;
  }

  const ds = createDraftSync(() => client, build, () => saveError, () => canEdit);
  const draft = $derived(ds.draft);
  const persistNow = createPersistNow(ds, () => client, onSave, onSaved);

  // Read-only fallback when there's no edit access: source straight from `client` (no draft exists).
  const notes = $derived(sortPinnedFirst(draft?.factors?.noteEntries ?? client.factors?.noteEntries ?? []));

  // Entries are tagged with their original (pre-sort) index before sorting, so Edit/Delete still hit
  // the right draft row once a pin reorders the display — mirrors Study.svelte's filteredEntries
  // (a pinned-note display reorder without this tagging edits/deletes the wrong array slot).
  const filteredNotes = $derived.by(() => {
    const tagged = (draft?.factors?.noteEntries ?? []).map((n, i) => ({ n, i, pinned: n.pinned }));
    return sortPinnedFirst(tagged);
  });

  // Add and Edit share one modal (mirrors FutureTreatment's Add): its Save persists immediately,
  // so every note visible in the list is guaranteed already-persisted. editIndex distinguishes
  // the two flows — null means Add (push), set means Edit (splice-in-place at that index).
  let addOpen = $state(false);
  let newNote = $state<NoteEntry | null>(null);
  let editIndex = $state<number | null>(null);
  function openAdd(attachment?: NoteAttachment) {
    newNote = { id: crypto.randomUUID(), text: "", ...(attachment ? { attachment } : {}) };
    editIndex = null;
    addOpen = true;
  }
  $effect(() => {
    if (autoOpenAdd) {
      openAdd();
      onAutoOpenAddConsumed?.();
    }
  });
  $effect(() => {
    if (pendingAttachment) {
      openAdd(pendingAttachment);
      onPendingAttachmentConsumed?.();
    }
  });
  function openEdit(n: NoteEntry, i: number) {
    newNote = { ...n };
    editIndex = i;
    addOpen = true;
  }
  function cancelAdd() {
    addOpen = false;
    newNote = null;
    editIndex = null;
  }
  function saveModalNote() {
    if (!newNote || !newNote.text.trim()) return;
    if (editIndex !== null) {
      draft!.factors!.noteEntries![editIndex] = { ...newNote };
    } else {
      draft!.factors!.noteEntries!.push(newNote);
    }
    persistNow((payload) => {
      payload.factors ??= {};
      payload.factors.noteEntries ??= [];
      if (editIndex !== null) {
        payload.factors.noteEntries[editIndex] = { ...newNote! };
      } else {
        payload.factors.noteEntries.push(newNote!);
      }
    }, noteAnchor(newNote.id));
    onTriggerRegen?.("noteResults");
    addOpen = false;
    newNote = null;
    editIndex = null;
  }

  // Persists immediately, scoped to just this item, built from the last-saved `client` (never the
  // live `draft`) — same shape as FutureTreatment's deleteDecision.
  function deleteNote(n: NoteEntry, i: number) {
    if (!confirm("Remove this note? This can't be undone.")) return;
    draft!.factors!.noteEntries!.splice(i, 1);
    persistNow((payload) => payload.factors!.noteEntries!.splice(i, 1), noteAnchor(n.id));
  }

  function buildAttachment(n: NoteEntry): NoteAttachment {
    return buildNoteAttachment(
      "note",
      { client: clientId ?? undefined, tab: "appointment", section: "notes", anchor: noteAnchor(n.id) },
      { title: n.text.trim().slice(0, 60) || "Note", tag: "Notes" },
    );
  }

  // W46 Phase 4 — a picked photo/document lands here (uploaded already; attachFiles ran inside the
  // shared leaf-actions attach handler), matched by id since a row's index can shift under
  // pinned-first sorting, same as toggleNotePin below.
  let attachError = $state<string | null>(null);
  function attachToNote(n: NoteEntry, added: Attachment[]) {
    const match = draft!.factors!.noteEntries!.find((x) => x.id === n.id);
    if (match) match.attachments = appendAttachments(match.attachments, added);
    persistNow((payload) => {
      const m = payload.factors!.noteEntries!.find((x) => x.id === n.id);
      if (m) m.attachments = appendAttachments(m.attachments, added);
    });
  }

  // Translate is leaf-specific (like Markers' — see MarkerChart.svelte's rowActions, and
  // UnifiedTreatment.svelte's Treatment rows), so it's prepended manually rather than living in the
  // shared standardLeafActions contract. Scoped to just this note (targetIds: [n.id]) — see
  // leaf-regen-registry.ts's noteResults spec for how a single id gets the model to see only this
  // row. force:true bypasses the staleness gate so the click always fires (see App.svelte's
  // regenNode comment); stays visible even when a result already exists so a provider can force a
  // re-check.
  // W64 — one implementation, in leaf-translate.svelte.ts. This block was byte-identical across
  // Notes/Study/Allergies/Family, comment included.
  const tr = createLeafTranslate(() => onTriggerRegen);
  const doTranslate = (n: NoteEntry) => tr.run(n.id, "noteResults", [n.id]);


  // W46 Phase 2 — canonical Edit → Chat → Annotate → Attach → Delete order via the shared
  // leaf-actions contract (was a hand-rolled array, no Annotate/Attach).
  function rowActions(n: NoteEntry, i: number): LeafMenuItem[] {
    return [
      {
        key: "translate",
        label: tr.translatingId === n.id ? "Translating…" : "Translate",
        title: "Translate",
        disabled: tr.translatingId === n.id,
        onClick: () => doTranslate(n),
      },
      ...standardLeafActions({
        edit: () => openEdit(n, i),
        chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "appointment", section: "notes", anchor: noteAnchor(n.id) }),
        annotate: onCreateNote ? () => onCreateNote!(buildAttachment(n)) : undefined,
        attach: clientId ? {
          clientId, onAttached: (added) => attachToNote(n, added), onError: (msg) => (attachError = msg),
        } : undefined,
        delete: () => deleteNote(n, i),
      }),
    ];
  }

  // M71 P6 — standalone Pin toggle, same clone-mutate-persist shape as toggleWatchlist (App.svelte:1071-1078),
  // matched by id since a row's index can shift under reordering.
  function toggleNotePin(n: NoteEntry) {
    const match = draft!.factors!.noteEntries!.find((x) => x.id === n.id);
    if (match) match.pinned = !match.pinned;
    persistNow((payload) => {
      const m = payload.factors!.noteEntries!.find((x) => x.id === n.id);
      if (m) m.pinned = !m.pinned;
    });
  }

</script>

{#snippet noteRow(n: NoteEntry, i: number)}
  {@const result = aiById.get(n.id)?.result}
  {#snippet patientTurn()}
    <p class="note-text">{n.text}</p>
    {#if n.attachment}<ReferenceCard reference={n.attachment} {onNavigate} />{/if}
    <AttachmentStrip attachments={n.attachments ?? []} {clientId} {attachmentUrl} productName={PRODUCT_NAME} />
  {/snippet}
  {#snippet aiTurn()}<p class="note-text">{result}</p>{/snippet}
  <!-- No title: a note has no short hand-picked label to head the card with (same reason NoteRow
       has none). The anchor still lands on the card. -->
  <TurnCard
    anchor={noteAnchor(n.id)}
    items={rowActions(n, i)}
    pinned={!!n.pinned}
    onTogglePin={() => toggleNotePin(n)}
    patient={patientTurn}
    ai={result ? aiTurn : undefined}
  />
{/snippet}

<div class="notes leaf-section">
  {#if canEdit && draft}
    <div class="nt-editbar">
      <div class="nte-title">
        <SaveStatus {saved} />
      </div>
    </div>
    <SaveStatus error={saveError} />
    <SaveStatus error={attachError} />
    <SaveStatus error={tr.translateError} />
  {/if}
  {#if notes.length === 0}
    <p class="leaf-empty">No notes yet{#if canEdit} — add one from the sidebar{/if}.</p>
  {:else if canEdit && draft}
    {#each filteredNotes as { n, i } (n)}{@render noteRow(n, i)}{/each}
  {:else}
    {#each pairs as p, i (i)}<NoteRow pair={p} {onNavigate} />{/each}
  {/if}
</div>

{#if addOpen && newNote}
  <Modal label={editIndex !== null ? "Edit note" : "Add note"} onClose={cancelAdd} snapshot={() => newNote}>
    <div class="nt-modal">
      {#if newNote.attachment}<ReferenceCard reference={newNote.attachment} />{/if}
      <Field label="Note" wide>
        <div class="field-row">
          <textarea class="note-input" rows="10" placeholder="Note…" bind:value={newNote.text}></textarea>
          <DictateButton onResult={(t) => (newNote!.text = newNote!.text ? `${newNote!.text} ${t}` : t)} />
        </div>
      </Field>
      <ModalActions>
        <Button onclick={cancelAdd}>Cancel</Button>
        <Button primary onclick={saveModalNote} disabled={!newNote.text?.trim()}>Save</Button>
      </ModalActions>
    </div>
  </Modal>
{/if}

<style>

  .note-text { margin: 0; font-size: 0.92rem; line-height: 1.5; color: var(--fg); white-space: pre-wrap; }

  .note-input {
    font: inherit; font-size: 1rem; line-height: 1.55; color: var(--fg);
    padding: 0.65rem 0.8rem; border: 1px solid var(--border); border-radius: 7px;
    background: white; width: 100%; box-sizing: border-box; resize: vertical; min-height: 3.5rem;
  }
  .note-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--band); }
</style>
