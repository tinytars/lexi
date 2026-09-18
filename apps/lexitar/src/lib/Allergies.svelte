<script lang="ts">
  import { createLeafTranslate } from "./leaf-translate.svelte";
  import { describeAiError } from "./ai-error";
  import type { Client, AllergyEntry, NoteAttachment, Attachment } from "./types";
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

  // M65 — split out of Personalization.svelte's former Correlations block (retired, its legacy data
  // folded into noteEntries) into its own Patient subsection. Same draft/resync + modal-Add +
  // object-identity edit-gate + persistNow CRUD pattern.
  // M94 — gained an AI-paired column (finding.allergyResults), mirroring Notes.svelte's aiCol.
  // M97 §C — allergyResults gained a real leaf-regen-registry.ts entry; onTriggerRegen now fires it.
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
    // for an allergy; the sidebar's one "Ungrouped" row is a selection anchor, not a filtering gap.
  }
  let {
    client, clientId = null, onSave, onSaved, onTriggerRegen, saved = false, saveError = null,
    onStartChat, onCreateNote, autoOpenAdd = false, onAutoOpenAddConsumed,
  }: Props = $props();

  // The AI response for a given allergy id, read-only (generated, not authored).
  const aiById = $derived(new Map((client.finding?.allergyResults ?? []).map((r) => [r.allergyId, r] as const)));

  function build(c: Client): Client {
    const d = structuredClone($state.snapshot(c)) as Client;
    d.factors ??= {};
    d.factors.allergies ??= [];
    return d;
  }

  const ds = createDraftSync(() => client, build, () => saveError);
  const draft = $derived(ds.draft);

  // M72 P2 — pinned-first view, same shape as Notes.svelte's `notes`; sortPinnedFirst preserves
  // object identity so draft.factors!.allergies!.indexOf(a) still resolves the true array index.
  const sortedAllergies = $derived(sortPinnedFirst(draft.factors!.allergies!));

  // M66 P4 — row anchors reuse conditionAnchor(allergen), disambiguated by the row's own index only
  // on a collision. W64 — one shared implementation (anchor.ts's rowAnchors); it existed six times,
  // including in the permalink RESOLVER, which has to agree with what is rendered here.
  const anchors = $derived(rowAnchors(sortedAllergies.map((x) => x.allergen)));


  const persistNow = createPersistNow(ds, () => client, onSave, onSaved);

  let addOpen = $state(false);
  let newAllergy = $state<AllergyEntry | null>(null);
  // W63 — the row being edited, by ID not by index. It was the index of the row in the SORTED view
  // (`sortedAllergies`) applied to the UNSORTED draft array: with anything pinned, Edit overwrote a
  // different allergy and Delete removed a different one, silently. toggleAllergyPin's own comment
  // already warned that "a row's index can shift under filtering/reordering".
  let editId = $state<string | null>(null);
  function openAdd() {
    newAllergy = { id: crypto.randomUUID(), allergen: "", reaction: "" };
    editId = null;
    addOpen = true;
  }
  $effect(() => {
    if (autoOpenAdd) {
      openAdd();
      onAutoOpenAddConsumed?.();
    }
  });
  function cancelAdd() {
    addOpen = false;
    newAllergy = null;
    editId = null;
  }
  function openEditAllergy(a: AllergyEntry) {
    newAllergy = { ...a };
    editId = a.id;
    addOpen = true;
  }
  function saveNewAllergy() {
    if (!newAllergy || !newAllergy.allergen.trim()) return;
    if (editId === null) {
      draft.factors!.allergies!.push(newAllergy);
      persistNow((p) => {
        p.factors ??= {};
        p.factors.allergies ??= [];
        p.factors.allergies.push(newAllergy!);
      }, conditionAnchor(newAllergy.allergen));
    } else {
      const id = editId;
      const edited = { ...newAllergy };
      // Append when the id is absent rather than skip — see Family.svelte's saveNewEntry for why
      // (persistNow's payload is the last-SAVED client, which may not have a just-added entry yet).
      const put = (list: AllergyEntry[]) => {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list[i] = edited; else list.push(edited);
      };
      put(draft.factors!.allergies!);
      persistNow((p) => {
        p.factors ??= {};
        p.factors.allergies ??= [];
        put(p.factors.allergies);
      }, conditionAnchor(edited.allergen));
    }
    onTriggerRegen?.("allergyResults");
    addOpen = false;
    newAllergy = null;
    editId = null;
  }
  function deleteAllergy(a: AllergyEntry) {
    if (!confirm(`Remove ${a.allergen ? `“${a.allergen}”` : "this allergy"}? This can't be undone.`)) return;
    const drop = (list: AllergyEntry[]) => {
      const i = list.findIndex((x) => x.id === a.id);
      if (i >= 0) list.splice(i, 1);
    };
    drop(draft.factors!.allergies!);
    persistNow((p) => drop(p.factors!.allergies!), "allergies-list");
  }

  // M71 P6 — standalone Pin toggle, same clone-mutate-persist shape as toggleWatchlist (App.svelte).
  // W64 — matched by id, not index. It took the row's index in the sorted VIEW (computed against
  // `draft` at the call site) and applied it to persistNow's payload, which is a clone of the
  // last-SAVED client: the two arrays differ exactly while an entry is added-but-unsaved, so this
  // flipped a different allergy's pin, or wrote past the end. Family.svelte's toggleEntryPin already
  // said why ("a row's index can shift under filtering/reordering") — W63 fixed Edit and Delete here
  // and missed this one. It also re-read `!p...pinned` from the payload rather than writing the
  // value just computed, so a payload that disagreed with the draft flipped the opposite way.
  function toggleAllergyPin(a: AllergyEntry) {
    const next = !a.pinned;
    const match = draft.factors!.allergies!.find((x) => x.id === a.id);
    if (match) match.pinned = next;
    persistNow((p) => {
      const m = p.factors?.allergies?.find((x) => x.id === a.id);
      if (m) m.pinned = next;
    }, "allergies-list");
  }

  function buildAttachment(a: AllergyEntry, i: number): NoteAttachment {
    return buildNoteAttachment(
      "allergy",
      { client: clientId ?? undefined, tab: "doctor", section: "allergies", anchor: anchors[i] },
      { title: a.allergen || "Allergy", subtitle: a.reaction, tag: "Allergies" },
    );
  }

  let attachError = $state<string | null>(null);
  function attachToAllergy(a: AllergyEntry, added: Attachment[]) {
    const match = draft.factors!.allergies!.find((x) => x.id === a.id);
    if (match) match.attachments = appendAttachments(match.attachments, added);
    persistNow((p) => {
      const m = p.factors!.allergies!.find((x) => x.id === a.id);
      if (m) m.attachments = appendAttachments(m.attachments, added);
    });
  }

  // Translate is leaf-specific (like Markers' — see MarkerChart.svelte's rowActions, and
  // UnifiedTreatment.svelte's Treatment rows), so it's prepended manually rather than living in the
  // shared standardLeafActions contract. Scoped to just this entry (targetIds: [a.id]) — see
  // leaf-regen-registry.ts's allergyResults spec. force:true bypasses the staleness gate so the
  // click always fires; stays visible even when a result already exists so a provider can force a
  // re-check.
  // W64 — one implementation, in leaf-translate.svelte.ts. This block was byte-identical across
  // Notes/Study/Allergies/Family, comment included.
  const tr = createLeafTranslate(() => onTriggerRegen);
  const doTranslate = (a: AllergyEntry) => tr.run(a.id, "allergyResults", [a.id]);


  // W46 Phase 2/4 — canonical Edit → Chat → Annotate → Attach → Delete order via the shared
  // leaf-actions contract (was a hand-rolled array, no Annotate/Attach).
  function rowActions(a: AllergyEntry, i: number): LeafMenuItem[] {
    // `i` is sortedAllergies' position; mutations need the true index into draft.factors!.allergies!.
    return [
      {
        key: "translate",
        label: tr.translatingId === a.id ? "Translating…" : "Translate",
        title: "Translate",
        disabled: tr.translatingId === a.id,
        onClick: () => doTranslate(a),
      },
      ...standardLeafActions({
        edit: () => openEditAllergy(a),
        chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "doctor", section: "allergies", anchor: anchors[i] }),
        annotate: onCreateNote ? () => onCreateNote!(buildAttachment(a, i)) : undefined,
        attach: clientId ? { clientId, onAttached: (added) => attachToAllergy(a, added), onError: (msg) => (attachError = msg) } : undefined,
        delete: () => deleteAllergy(a),
      }),
    ];
  }
</script>

<div class="allergies leaf-section">
  <div class="az-editbar">
    <div class="az-title">
      <SaveStatus {saved} />
    </div>
  </div>
  <SaveStatus error={saveError} />
  <SaveStatus error={attachError} />
  <SaveStatus error={tr.translateError} />

  <section class="az-block" id="allergies-list">
    {#if sortedAllergies.length === 0}
      <p class="leaf-empty">No known allergies yet — add one from the sidebar.</p>
    {:else}
      {#each sortedAllergies as a, i (a.id)}
        {@const result = aiById.get(a.id)?.result}
        <!-- A counter, not a HeadingAnchor, heads this card — the allergen's own anchor lives in the
             patient half. That is why TurnCard's title can be free-form. -->
        {#snippet num()}<span class="entry-num">#{i + 1}</span>{/snippet}
        {#snippet patientTurn()}
          <FormGrid>
            <span class="field"><HeadingAnchor anchor={anchors[i]} label="Copy link to this allergy">{a.allergen || "Untitled"}</HeadingAnchor></span>
            <span class="field">{a.reaction || "No reaction noted."}</span>
            <span class="field">{a.severity || "—"}</span>
            <span class="field">{a.dateNoted || "No date"}</span>
          </FormGrid>
          <AttachmentStrip attachments={a.attachments ?? []} {clientId} {attachmentUrl} productName={PRODUCT_NAME} />
        {/snippet}
        {#snippet aiTurn()}<p class="az-text">{result}</p>{/snippet}
        <TurnCard
          titleContent={num}
          items={rowActions(a, i)}
          pinned={!!a.pinned}
          onTogglePin={() => toggleAllergyPin(a)}
          patient={patientTurn}
          ai={result ? aiTurn : undefined}
        />
      {/each}
    {/if}
  </section>
</div>

{#if addOpen && newAllergy}
  <Modal label={editId === null ? "Add allergy" : "Edit allergy"} onClose={cancelAdd} snapshot={() => newAllergy}>
    <div class="az-modal">
      <Field label="Allergen">
        <div class="field-row">
          <input type="text" placeholder="e.g. Penicillin" bind:value={newAllergy.allergen} />
          <DictateButton onResult={(t) => (newAllergy!.allergen = newAllergy!.allergen ? `${newAllergy!.allergen} ${t}` : t)} />
        </div>
      </Field>
      <Field label="Reaction">
        <div class="field-row">
          <input type="text" placeholder="e.g. Hives" bind:value={newAllergy.reaction} />
          <DictateButton onResult={(t) => (newAllergy!.reaction = newAllergy!.reaction ? `${newAllergy!.reaction} ${t}` : t)} />
        </div>
      </Field>
      <Field label="Severity">
        <select bind:value={newAllergy.severity}>
          <option value={undefined}>—</option>
          <option value="mild">Mild</option>
          <option value="moderate">Moderate</option>
          <option value="severe">Severe</option>
        </select>
      </Field>
      <Field label="Date noted"><input type="date" bind:value={newAllergy.dateNoted} /></Field>
      <ModalActions>
        <Button onclick={cancelAdd}>Cancel</Button>
        <Button primary onclick={saveNewAllergy} disabled={!newAllergy.allergen.trim()}>Save</Button>
      </ModalActions>
    </div>
  </Modal>
{/if}

<style>

  input, select {
    font: inherit; font-size: 0.95rem; color: var(--fg);
    padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: white; width: 100%; box-sizing: border-box;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--band); }

  .entry-num { font-size: 0.78rem; color: var(--muted); font-weight: 600; }

  .az-text { margin: 0; font-size: 0.92rem; line-height: 1.5; color: var(--fg); white-space: pre-wrap; }


  @media print { .allergies { display: none !important; } }
</style>
