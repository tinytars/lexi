<script lang="ts">
  import { createLeafTranslate } from "./leaf-translate.svelte";
  import { describeAiError } from "./ai-error";
  import type { Client, StudyEntry, NoteAttachment, Attachment } from "./types";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";
  import TurnCard from "./TurnCard.svelte";
  import AttachmentStrip from "@tinytars/frame/AttachmentStrip.svelte";
  import { appendAttachments, attachmentUrl } from "./attachment-store";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import PendingGrouping from "./PendingGrouping.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import Modal from "@tinytars/frame/Modal.svelte";
  import Button from "@tinytars/frame/Button.svelte";
  import Field from "@tinytars/frame/Field.svelte";
  import ModalActions from "@tinytars/frame/ModalActions.svelte";
  import SaveStatus from "@tinytars/frame/SaveStatus.svelte";
  import { studyAnchor } from "./anchor";
  import StudyRow from "./StudyRow.svelte";
  import { buildStudyPairs } from "./study-pairs";
  import { groupBySystem } from "@pablotech/akesi/system-groups";
  import { createDraftSync, createPersistNow } from "./draft-sync.svelte";
  import type { Permalink } from "./permalink";
  import { sortPinnedFirst } from "./pin-sort";
  import { PRODUCT_NAME } from "./brand";

  // The Study subsection of AI Thoughts (moved out of Analysis). The patient's pursued-study rows
  // (each named entry) paired with the AI's answer (finding.studyResults,
  // matched by label verbatim — see scripts/claude-finding.ts). Read-only for a patient; the provider
  // adds/edits/deletes entries via the shared Add/Edit modal (M67, mirrors Treatment/Hypothesis),
  // each persisting immediately through the shell's saveEdits → saveVault path. The AI answer column
  // stays read-only (regenerated on refresh).
  interface Props {
    client: Client;
    clientId?: string | null;
    onSave?: (updated: Client) => void;
    onSaved?: (anchor: string) => void;
    // M66 P7 — fires right after a study-result Add/Save so the shell kicks off a background
    // studyResults regen immediately, instead of waiting on its own staleness effect. The second arg
    // scopes the regen to just this row's label (verbatim, matching finding.studyResults[].study) so
    // the model only has to answer this one row instead of every populated one.
    onTriggerRegen?: (key: string, targetLabels?: string[], force?: boolean) => Promise<{ status: "filled" | "empty" | "skipped" | "failed"; error?: string }>;
    saved?: boolean;
    saveError?: string | null;
    onStartChat?: (pl: Permalink) => void;
    // M-annotate — a study row's "Annotate" menu item hands its attachment up to the shell.
    onCreateNote?: (attachment: NoteAttachment) => void;
    // M75 — a sidebar "+" navigated here and wants the Add modal opened automatically.
    autoOpenAdd?: boolean;
    onAutoOpenAddConsumed?: () => void;
    // Single-group by design (owner decision #3, M97 §E) — no natural subcategory field exists
    // for a study row; the sidebar's one "Ungrouped" row is a selection anchor, not a filtering gap.
  }
  let {
    client, clientId = null, onSave, onSaved, onTriggerRegen, saved = false, saveError = null,
    onStartChat, onCreateNote, autoOpenAdd = false, onAutoOpenAddConsumed,
  }: Props = $props();

  // M51 — edit availability is just whether a save sink is wired (patient and provider both edit).
  const canEdit = $derived(!!onSave);

  // Read-only pairing (patient view): patient rows ↔ AI results, grouped by body system.
  const pairs = $derived(buildStudyPairs(client));
  const grouped = $derived.by(() => groupBySystem(client, pairs, (p) => p.group));

  // The AI answer for a given row label — read-only in both views (it's generated, not authored).
  const aiByLabel = $derived(new Map((client.finding?.studyResults ?? []).map((r) => [r.study, r] as const)));

  // Edit draft — always-on for the provider (no Edit toggle); createDraftSync resyncs it to the
  // live client only when its identity changes (patient switch / post-save reload), so
  // in-progress edits aren't clobbered.
  function build(c: Client): Client {
    const d = structuredClone($state.snapshot(c)) as Client;
    d.study ??= {};
    d.study.entries ??= [];
    return d;
  }

  const ds = createDraftSync(() => client, build, () => saveError, () => canEdit);
  const draft = $derived(ds.draft);
  const persistNow = createPersistNow(ds, () => client, onSave, onSaved);

  // M67 — Edit reopens the same Add modal (pre-filled), mirroring Treatment/Hypothesis, instead of
  // the old per-row SvelteSet edit-gate. editTarget distinguishes add (null) from edit-entry, and
  // points at which draft/payload index Save overwrites.
  type EditTarget = { kind: "entry"; index: number };
  let addOpen = $state(false);
  let newEntry = $state<StudyEntry | null>(null);
  let editTarget = $state<EditTarget | null>(null);
  function openAdd() {
    newEntry = { id: crypto.randomUUID(), focus: "", detail: "" };
    editTarget = null;
    addOpen = true;
  }
  $effect(() => {
    if (autoOpenAdd) {
      openAdd();
      onAutoOpenAddConsumed?.();
    }
  });
  function openEditEntry(e: StudyEntry, i: number) {
    newEntry = { ...e };
    editTarget = { kind: "entry", index: i };
    addOpen = true;
  }
  function cancelAdd() {
    addOpen = false;
    newEntry = null;
    editTarget = null;
  }
  function saveNewEntry() {
    if (!newEntry) return;
    if (!newEntry.focus?.trim()) return;
    if (editTarget?.kind === "entry") {
      draft!.study!.entries![editTarget.index] = newEntry;
    } else {
      draft!.study!.entries!.push(newEntry);
    }
    persistNow((payload) => {
      payload.study ??= {};
      payload.study.entries ??= [];
      if (editTarget?.kind === "entry") {
        payload.study.entries[editTarget.index] = newEntry!;
      } else {
        payload.study.entries.push(newEntry!);
      }
    }, studyAnchor(newEntry.focus));
    onTriggerRegen?.("studyResults", [newEntry.focus]);
    addOpen = false;
    newEntry = null;
    editTarget = null;
  }

  // Delete is a direct row action (mirrors Treatment/FutureTreatment) — confirm()-gated, not behind
  // opening Edit. M56 — persists immediately, scoped to just this item: the network payload is built
  // from the last-saved `client` (not the live `draft`), so any other row's in-progress-but-unsaved
  // edit is structurally excluded, never silently swept in or lost.
  function deleteEntry(e: StudyEntry, i: number) {
    const name = e.focus?.trim() || "this study";
    if (!confirm(`Remove ${name}? This can't be undone.`)) return;
    draft!.study!.entries!.splice(i, 1);
    persistNow((payload) => payload.study!.entries!.splice(i, 1), studyAnchor(e.focus));
  }
  // M71 P6 — standalone Pin toggle per entry, same scoped-persist shape as deleteEntry above: mutate
  // a clone of the last-saved `client` (never the live `draft`) and persist immediately.
  function togglePin(e: StudyEntry) {
    if (!draft) return;
    const flip = (c: Client) => {
      const match = c.study?.entries?.find((x) => x.id === e.id);
      if (match) match.pinned = !match.pinned;
    };
    flip(draft);
    if (!client.study?.entries?.some((x) => x.id === e.id)) return; // added this session, never saved
    persistNow(flip);
  }
  // M-annotate — mirrors ChatTab.svelte's buildAttachment: a self-contained permalink + preview
  // back to this study row, using the same anchor the "Chat" item below already builds.
  function buildAttachment(e: StudyEntry): NoteAttachment {
    return buildNoteAttachment(
      "study",
      { client: clientId ?? undefined, tab: "ai", section: "study", anchor: studyAnchor(e.focus) },
      { title: e.focus || "Untitled", subtitle: e.detail, tag: "Study" },
    );
  }

  let attachError = $state<string | null>(null);
  function attachToStudy(e: StudyEntry, added: Attachment[]) {
    const match = draft!.study!.entries!.find((x) => x.id === e.id);
    if (match) match.attachments = appendAttachments(match.attachments, added);
    persistNow((payload) => {
      const m = payload.study!.entries!.find((x) => x.id === e.id);
      if (m) m.attachments = appendAttachments(m.attachments, added);
    });
  }

  // Translate is leaf-specific (like Markers' — see MarkerChart.svelte's rowActions, and
  // UnifiedTreatment.svelte's Treatment rows), so it's prepended manually rather than living in the
  // shared standardLeafActions contract. studyResults is a scopedArrayKey node (content-scoped by
  // e.focus, same as the save-trigger above), so this only regenerates this one row. force:true
  // bypasses the staleness gate so the click always fires (see App.svelte's regenNode comment);
  // stays visible even when a result already exists so a provider can force a re-check.
  // W64 — one implementation, in leaf-translate.svelte.ts. This block was byte-identical across
  // Notes/Study/Allergies/Family, comment included.
  const tr = createLeafTranslate(() => onTriggerRegen);
  const doTranslate = (e: StudyEntry) => tr.run(e.id, "studyResults", [e.focus]);


  // W46 Phase 2/4 — canonical Edit → Chat → Annotate → Attach → Delete order via the shared
  // leaf-actions contract (was a hand-rolled array).
  function rowActions(e: StudyEntry, i: number): LeafMenuItem[] {
    return [
      {
        key: "translate",
        label: tr.translatingId === e.id ? "Translating…" : "Translate",
        title: "Translate",
        disabled: tr.translatingId === e.id,
        onClick: () => doTranslate(e),
      },
      ...standardLeafActions({
        edit: () => openEditEntry(e, i),
        chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "ai", section: "study", anchor: studyAnchor(e.focus) }),
        annotate: onCreateNote ? () => onCreateNote!(buildAttachment(e)) : undefined,
        attach: clientId ? { clientId, onAttached: (added) => attachToStudy(e, added), onError: (msg) => (attachError = msg) } : undefined,
        delete: () => deleteEntry(e, i),
      }),
    ];
  }
  // Entries are tagged with their original index (so edit/delete still hit the right draft row).
  const filteredEntries = $derived.by(() => {
    const tagged = (draft?.study?.entries ?? []).map((e, i) => ({ e, i, pinned: e.pinned }));
    return sortPinnedFirst(tagged);
  });
</script>

{#snippet entryRow(e: StudyEntry, i: number)}
  {@const hasPatient = !!e.detail || (e.attachments?.length ?? 0) > 0}
  {@const result = aiByLabel.get(e.focus)?.result}
  <!-- Nested snippets, not parameterized ones: TurnCard's halves are zero-arg Snippets, and these
       close over `e` from the enclosing snippet's own scope. -->
  {#snippet patientTurn()}
    {#if e.detail}<p class="sr-text">{e.detail}</p>{/if}
    <AttachmentStrip attachments={e.attachments ?? []} {clientId} {attachmentUrl} productName={PRODUCT_NAME} />
  {/snippet}
  {#snippet aiTurn()}<p class="sr-text">{result}</p>{/snippet}
  <TurnCard
    anchor={studyAnchor(e.focus)}
    label={e.focus || "Untitled"}
    items={rowActions(e, i)}
    pinned={!!e.pinned}
    onTogglePin={() => togglePin(e)}
    patient={hasPatient ? patientTurn : undefined}
    ai={result ? aiTurn : undefined}
    patientEmpty="No detail yet."
  />
{/snippet}

<div class="study leaf-section">
  {#if canEdit && draft}
    <div class="study-editbar"><SaveStatus {saved} /></div>
    <SaveStatus error={saveError} />
    <SaveStatus error={attachError} />
    <SaveStatus error={tr.translateError} />

    {#each filteredEntries as { e, i } (e)}{@render entryRow(e, i)}{/each}
  {:else if pairs.length === 0}
    <p class="leaf-empty">No pursued study on record for {client.displayName}.</p>
  {:else}
    {#if grouped}
      {#each grouped as grp (grp.system)}
        <h4 class="sr-system">{grp.system}</h4>
        {#each grp.rows as p, i (i)}<StudyRow pair={p} />{/each}
      {/each}
    {:else}
      <PendingGrouping />
      {#each pairs as p, i (i)}<StudyRow pair={p} />{/each}
    {/if}
  {/if}
</div>

{#if addOpen && newEntry}
  <Modal label={editTarget?.kind === "entry" ? "Edit study" : "Add study"} onClose={cancelAdd} snapshot={() => newEntry}>
    <div class="study-modal">
      <Field label="Focus" wide>
        <div class="field-row">
          <input class="topic-input" type="text" placeholder="e.g. Selection" bind:value={newEntry.focus} />
          <DictateButton onResult={(t) => (newEntry!.focus = newEntry!.focus ? `${newEntry!.focus} ${t}` : t)} />
        </div>
      </Field>
      <Field label="Detail" wide>
        <div class="field-row">
          <textarea class="sr-input" rows="3" placeholder="Detail / question…" bind:value={newEntry.detail}></textarea>
          <DictateButton onResult={(t) => (newEntry!.detail = newEntry!.detail ? `${newEntry!.detail} ${t}` : t)} />
        </div>
      </Field>
      <ModalActions>
        <Button onclick={cancelAdd}>Cancel</Button>
        <Button primary onclick={saveNewEntry} disabled={!newEntry.focus?.trim()}>Save</Button>
      </ModalActions>
    </div>
  </Modal>
{/if}

<style>
  .sr-system { margin: 1.4rem 0 0.6rem; font-size: 0.9rem; font-weight: 700; color: var(--accent); }
  .sr-system:first-of-type { margin-top: 0; }
  .sr-text { margin: 0; font-size: 0.9rem; line-height: 1.5; color: var(--fg); }

  /* M67 — row CRUD via the shared Add/Edit modal (mirrors the Treatment editor). */
  .sr-input {
    font: inherit; font-size: 1rem; line-height: 1.55; color: var(--fg);
    padding: 0.65rem 0.8rem; border: 1px solid var(--border); border-radius: 7px;
    background: white; width: 100%; box-sizing: border-box; resize: vertical; min-height: 5rem;
  }
  .sr-input:focus, .topic-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--band); }
</style>
