<script lang="ts">
  import { tick } from "svelte";
  import { describeAiError } from "./ai-error";
  import { assessmentFor } from "@pablotech/akesi/treatment-bucket";
  import { partitionByBucket } from "./treatment-sidebar";
  import { formatIngredient, hasProductData } from "@pablotech/akesi/treatment-product";
  import { computeConclusion, isConclusion, conclusionMessage, formatIngredientTotal } from "./treatment-conclusion";
  import type { Attachment, Client, NoteAttachment, TreatmentItem } from "./types";
  import PersonaBubble, { type BubbleAction } from "@tinytars/frame/PersonaBubble.svelte";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";
  import LeafCard from "@tinytars/frame/LeafCard.svelte";
  import PendingGrouping from "./PendingGrouping.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import { treatmentAnchor, findByAnchor } from "./anchor";
  import { groupBySystem } from "@pablotech/akesi/system-groups";
  import { planActionSystems } from "./treatment-groups";
  import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
  import { foldLegacyTreatments, treatmentEditDraft } from "./treatment-legacy-fold";
  import { createDraftSync, createPersistNow } from "./draft-sync.svelte";
  import { bucketOf, collapseByName, treatmentLabel, todayISODate, BUCKET_LABEL, groupByName, dateGaps, formatDose, type NamedTreatmentGroup } from "@pablotech/akesi/treatment-bucket";
  import { sortPinnedFirst } from "./pin-sort";
  import { formatDay, isCompleteDate } from "@pablotech/akesi/dates";
  import Modal from "@tinytars/frame/Modal.svelte";
  import Button from "@tinytars/frame/Button.svelte";
  import Field from "@tinytars/frame/Field.svelte";
  import SaveStatus from "@tinytars/frame/SaveStatus.svelte";
  import { compressImage } from "./image-compress";
  import { inferTreatmentRecord } from "./treatment-infer-client";
  import { mergeInferredFields } from "./treatment-infer-merge";
  import { wasSavedThisSession } from "./treatment-session-guard";
  import { duplicateTreatment, clearExtractedData, togglePin, removeTreatmentsById, mirrorAttachments, removeAttachment, deleteTreatmentPrompt, deleteMedicinePrompt } from "./treatment-mutations";
  import { hasAnyDose as hasAnyDoseInTreatments, editIndexOf as editIndexOfRow } from "./treatment-row-lookup";
  import { uploadPendingImages, mergeUploadedImages } from "./treatment-attachment-upload";
  import { planTreatmentSave, applyTreatmentSave, type TreatmentFieldScope as FieldScope } from "./treatment-save";
  import { appendAttachments, buildAttachmentKey, uploadAttachment, attachmentUrl, attachmentsOf, groupAttachmentsOf, attachFiles, MAX_VISION_ATTACHMENTS } from "./attachment-store";
  import { openAttachPicker, DEFAULT_ATTACH_ACCEPT } from "@tinytars/frame/attach-controller";
  import AttachmentStrip from "@tinytars/frame/AttachmentStrip.svelte";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import type { Permalink } from "./permalink";
  import TreatmentRow, { type Row, buildTreatmentRows } from "./TreatmentRow.svelte";
  import { PRODUCT_NAME } from "./brand";

  // W31 — the unified treatment view: one heterogeneous list (drugs, supplements, behaviors) split
  // into three temporal sets derived from start/end. Ongoing and Planned carry the AI's per-treatment
  // assessment on the right (Ongoing from finding.treatment, Planned from finding.planAssessmentRows).
  // M-medicine-leaf — Past now carries one too, from the SAME finding.treatment array as Ongoing
  // (treatmentAssessment reassesses both), commenting on what's continued/begun since it concluded.
  // Titration rows collapse by name; a holistic plan assessment closes it.
  //
  // W34 — the provider edits factors.treatments IN PLACE, in the default view (no Edit toggle): each raw
  // item shows as its own editable row (uncollapsed, so a per-item ✕/field maps 1:1 — titration steps stay
  // distinct) under its live temporal bucket, with the saved AI assessment on the right. Persists through
  // the shell's saveEdits → saveVault path; patient/read-only views (no onSave) keep the collapsed read view.
  interface Props {
    client: Client;
    clientId?: string | null;
    onSave?: (updated: Client) => void;
    onSaved?: (anchor: string) => void;
    // M66 P7 — fires right after a treatment Add/Save: treatmentAssessment for an ongoing/past-bucket
    // save, aiOnPlan for a planned-bucket save (bucket derived from dates, same as the row's own logic),
    // so the shell kicks off the matching background regen immediately.
    onTriggerRegen?: (key: string, targetLabels?: string[], force?: boolean) => Promise<{ status: "filled" | "empty" | "skipped" | "failed"; error?: string }>;
    saved?: boolean;
    saveError?: string | null;
    // M70/Phase 0 — plumbing only; wired to a "Chat" button in a later phase.
    onStartChat?: (pl: Permalink) => void;
    // W46 — Annotate goes universal (was on 6 of ~12 leaf types); this leaf had neither the prop
    // nor a menu item for it.
    onCreateNote?: (attachment: NoteAttachment) => void;
    // M75 — a sidebar "+" navigated here and wants the Add modal opened automatically.
    autoOpenAdd?: boolean;
    onAutoOpenAddConsumed?: () => void;
    // M76/Phase 3 — which sidebar bucket ("ongoing"/"planned"/"past") is selected; the page renders
    // exactly that one bucket instead of every bucket stacked. Bindable so the pendingAnchor
    // reverse-match effect below can switch it.
    activeGroup?: string | null;
    // A deep-linked anchor whose owning bucket may not be the currently active one; reverse-matched
    // against the full unfiltered/uncollapsed treatment set below, then cleared via onConsumeAnchor.
    pendingAnchor?: string | null;
    onConsumeAnchor?: () => void;
  }
  let {
    client, clientId = null, onSave, onSaved, onTriggerRegen, saved = false, saveError = null,
    onStartChat, onCreateNote, autoOpenAdd = false, onAutoOpenAddConsumed,
    activeGroup = $bindable(null), pendingAnchor = null, onConsumeAnchor,
  }: Props = $props();

  const today = todayISODate();
  // M51 — patient and provider share one editable view; edit availability is purely whether a save
  // sink is wired (it always is from the shell). The read-only branch survives only for a no-onSave host.
  const canEdit = $derived(!!onSave);

  // Edit draft — always-on; createDraftSync resyncs it to the live client only when its identity
  // changes (patient switch / post-save reload).
  function build(c: Client): Client {
    return treatmentEditDraft(structuredClone($state.snapshot(c)) as Client);
  }

  // The immediate-persist payload must be folded like `draft`: `client.factors.treatments` may still
  // be legacy-shaped while draft's index `i` assumes the already-folded array.
  function treatmentBaseline(c: Client): Client {
    return foldLegacyTreatments(structuredClone($state.snapshot(c)) as Client);
  }

  const ds = createDraftSync(() => client, build, () => saveError, () => canEdit);
  const draft = $derived(ds.draft);
  const persistNow = createPersistNow(ds, () => client, onSave, onSaved, treatmentBaseline);

  // One lookup for every bucket — see assessmentFor. A drug can hold three assessments now, one per
  // phase, so the Past card no longer renders the text written about the current dose.
  function assessmentOf(t: TreatmentItem): string | undefined {
    return assessmentFor(client.finding, t.name, bucketOf(t, today), undefined, t.id)?.assessment;
  }

  // M66 — a row always reads as a bubble (✎ Edit / ⌕ show-only); Edit opens the shared Add/Edit
  // modal pre-filled from the row, rather than swapping to an in-place form.
  let addOpen = $state(false);
  let newTreatment = $state<TreatmentItem | null>(null);
  let editingIndex = $state<number | null>(null);
  // Which slice of the record the open modal is editing — see treatmentFields' comment.
  let editScope = $state<FieldScope>("all");
  // The medicine being edited under scope "medicine", captured PRE-rename so the save can still find
  // every row of it after the name field changes.
  let editGroupName = $state<string | null>(null);
  // M107 — auto-advance targets for treatmentFields' Start→End and Amount→Unit→Frequency flow.
  // $state since M-medicine-fields put these fields behind a scope conditional: they now mount and
  // unmount as the modal's scope changes, so the binding has to stay reactive to survive that.
  let endDateInput = $state<HTMLInputElement | undefined>();
  let unitInput = $state<HTMLInputElement | undefined>();
  let frequencySelect = $state<HTMLSelectElement | undefined>();
  // "manual" is gone — a brand-new treatment's only entry point is a capture (see captureRequired
  // below); this toggle now only ever chooses which capture method.
  let addMode = $state<"photos" | "text">("photos");
  let pendingText = $state("");
  // usedForIdentify marks which of these produced the currently-recorded extraction, so
  // saveNewTreatment can stamp the resulting Attachment keys onto rawCaptureAttachmentKeys — a
  // photo added but never run through Identify is just an attachment, not a raw capture.
  let pendingImages = $state<{ file: File; previewUrl: string; usedForIdentify?: boolean }[]>([]);
  let identifying = $state(false);
  let identified = $state(false);
  let identifyError = $state<string | null>(null);
  let savingNew = $state(false);
  let saveImageError = $state<string | null>(null);
  // A brand-new treatment (fresh Add, "all" scope) has no other way in: nothing but the capture
  // widgets render until identifyFrom() succeeds and stamps `extracted` — true forever after, even
  // across a later abandoned retry, since `extracted` persists once set. Editing an existing
  // treatment (any other combination of editingIndex/editScope) is never gated by this.
  const captureRequired = $derived(editingIndex === null && editScope === "all" && !newTreatment?.extracted);

  function revokePendingImages() {
    for (const p of pendingImages) URL.revokeObjectURL(p.previewUrl);
    pendingImages = [];
  }
  function onPickImages(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const room = 4 - pendingImages.length;
    for (const f of files.slice(0, room)) {
      pendingImages.push({ file: f, previewUrl: URL.createObjectURL(f) });
    }
    input.value = "";
  }
  function removeImage(idx: number) {
    URL.revokeObjectURL(pendingImages[idx].previewUrl);
    pendingImages.splice(idx, 1);
    identified = false;
    identifyError = null;
  }
  // One handler for both intakes — the endpoint takes photos or text and answers in the same shape,
  // so the only difference here is which one is non-empty. Product fields are merged in only when
  // the model actually returned them, so re-running an extraction can never blank a field the user
  // has already typed or a previous run filled.
  async function identifyFrom(source: "photos" | "text") {
    if (!newTreatment) return;
    const compressed = source === "photos"
      ? await Promise.all(pendingImages.map((p) => compressImage(p.file)))
      : [];
    if (source === "photos" && compressed.length === 0) return;
    if (source === "text" && !pendingText.trim()) return;
    identifying = true;
    identifyError = null;
    try {
      const result = await inferTreatmentRecord(
        source === "photos"
          ? { images: compressed.map((c) => ({ bytes: c.bytes, mediaType: c.mediaType })) }
          : { text: pendingText },
      );
      Object.assign(newTreatment, mergeInferredFields(result, source, pendingText));
      // Photo provenance: mark which pendingImages produced this run so saveNewTreatment (below)
      // can stamp their eventual Attachment keys.
      if (source === "photos") {
        pendingImages = pendingImages.map((p) => ({ ...p, usedForIdentify: true }));
      }
      identified = true;
    } catch (err) {
      identifyError = describeAiError(err);
    } finally {
      identifying = false;
    }
  }
  // M107 — Amount is type="number", so it silently swallows any non-numeric keystroke (old muscle
  // memory from the pre-split "6mg/week" single field types straight through "m"/"g" after the
  // digits). Forward that keystroke into Unit instead of letting it vanish, and move focus there.
  function advanceFromAmount(e: KeyboardEvent, t: TreatmentItem) {
    if (e.key.length !== 1 || /[\d.\-eE]/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    t.doseUnit = (t.doseUnit ?? "") + e.key;
    unitInput?.focus();
    tick().then(() => unitInput?.setSelectionRange(unitInput.value.length, unitInput.value.length));
  }
  // M107 — "/" continues the same old "6mg/week" muscle memory as the separator into Frequency
  // (a <select>, so native type-ahead picks up whatever's typed next — no need to forward the key).
  function advanceFromUnit(e: KeyboardEvent) {
    if (e.key !== "/") return;
    e.preventDefault();
    frequencySelect?.focus();
  }
  function buildAttachment(t: TreatmentItem): NoteAttachment {
    return buildNoteAttachment(
      "treatment",
      { client: clientId ?? undefined, tab: "doctor", section: "treatment", anchor: treatmentAnchor(t.name) },
      { title: t.name || "Treatment", subtitle: formatDose(t), tag: "Treatment" },
    );
  }

  // W46 Phase 4 — matched by id (mirrors togglePinTreatment above), not x.i: attach can fire from
  // any row regardless of which bucket/collapsed view it's currently rendered in.
  let attachError = $state<string | null>(null);
  function attachToTreatment(t: TreatmentItem, added: Attachment[]) {
    if (!draft) return;
    mirrorAttachments(draft.factors?.treatments, t.name, added);
    if (!wasSavedThisSession(client, t.id)) return;
    persistNow((payload) => mirrorAttachments(payload.factors?.treatments, t.name, added));
  }

  // Translate is leaf-specific (like Markers' — see MarkerChart.svelte's rowActions), so it's
  // prepended manually rather than living in the shared standardLeafActions contract. Unlike
  // Markers' (which hides once a personalized range exists), this stays visible even when an
  // assessment is already present — a provider may want to force a re-check after upstream data
  // changed without re-editing the row. Shown whenever `showAi` is true — Ongoing/Planned/Past
  // (M-medicine-leaf) all carry an AI bubble now, so all three get Translate too.
  let translatingId = $state<string | null>(null);
  // A mute spinner reads as a hang even when the request is healthy, so the wait is always counted
  // out loud — and the count doubles as the evidence for how long a failure actually took.
  let translateElapsed = $state(0);
  $effect(() => {
    if (!translatingId) return;
    translateElapsed = 0;
    const started = Date.now();
    const timer = setInterval(() => (translateElapsed = Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  });
  let translateError = $state<string | null>(null);
  // Which row/group the message belongs to, so it renders AT the thing that was clicked. A single
  // page-level error line (what this used to be) is off-screen for any row below the fold, which is
  // why a failing Translate read as "the button does nothing".
  let translateErrorId = $state<string | null>(null);
  async function doTranslate(t: TreatmentItem) {
    translatingId = t.id;
    translateError = null;
    translateErrorId = t.id;
    try {
      const r = await onTriggerRegen?.("treatmentAssessment", [t.name], true);
      if (r?.status === "failed") translateError = r.error ?? "Couldn't translate.";
      else if (r?.status === "empty") translateError = "Nothing to translate yet.";
      // "skipped" is normally a no-op worth no comment (the client switched mid-flight), but the
      // single-flight lock reports a reason — surface it rather than swallowing the click.
      else if (r?.status === "skipped" && r.error) translateError = r.error;
      else translateErrorId = null;
    } catch (e) {
      translateError = describeAiError(e);
    } finally {
      translatingId = null;
    }
  }

  // M-medicine-group — Medicine's card is one whole medicine, and carries the SAME action contract
  // every other leaf has (Translate prepended, then standardLeafActions, with Pin as LeafCard's own
  // separate control): Edit/Delete act on the medicine as a whole, per-dose-entry Edit/Duplicate/
  // Delete live in the history table inside the card.
  function groupActions(g: NamedTreatmentGroup): BubbleAction[] {
    const rep = g.rows[0];
    return [
      {
        key: "translate",
        label: translatingId === rep.id ? "Translating…" : "Translate",
        title: "Translate",
        disabled: translatingId === rep.id,
        onClick: () => doTranslate(rep),
      },
      ...standardLeafActions({
        edit: () => startEditMedicine(g),
        chat: () => onStartChat?.({ client: clientId ?? undefined, tab: "doctor", section: "treatment", anchor: treatmentAnchor(g.name) }),
        annotate: onCreateNote ? () => onCreateNote!(buildAttachment(rep)) : undefined,
        attach: clientId ? {
          clientId, maxCount: MAX_VISION_ATTACHMENTS,
          onAttached: (added) => attachToTreatment(rep, added), onError: (msg) => (attachError = msg),
        } : undefined,
        delete: () => deleteMedicine(g),
      }),
    ];
  }
  // Pin on a medicine flags its representative row, and All's group list sorts pinned-first —
  // the same "pinned floats to the top of this list" behavior Pin has in every other leaf.
  function togglePinMedicine(g: NamedTreatmentGroup) {
    togglePinTreatment(g.rows[0]);
  }

  // A long titration (Tirzepatide runs to 11 dose periods) buries every other medicine below it, so
  // a group shows its most recent few and offers the rest behind one tick. Keyed by drug name, not
  // index, so the flag follows the medicine as groups re-sort (pinned-first, bucket order).
  const MEDICINE_PREVIEW_ROWS = 3;
  let expandedGroups = $state<Record<string, boolean>>({});
  function shownRows(g: NamedTreatmentGroup): TreatmentItem[] {
    return expandedGroups[g.name] ? g.rows : g.rows.slice(0, MEDICINE_PREVIEW_ROWS);
  }

  // M66 — Delete is a direct row action (confirm()-gated in deleteTreatment itself), matching the
  // Family/Allergies/Hypothesis/Notes/Reports pattern, not gated behind opening Edit.
  // W46 Phase 2/4 — canonical Edit → Chat → Annotate → Attach → Delete order via the shared
  // leaf-actions contract (was a hand-rolled array, no Annotate/Attach). Attach here now also
  // covers what used to be "photos only at treatment-creation time" — any existing row can attach.
  // M56 — persists immediately, scoped to just this item (see Study.svelte's deleteEntry for the
  // full rationale).
  function deleteTreatment(t: TreatmentItem, i: number) {
    if (!confirm(deleteTreatmentPrompt(t, draft?.factors?.treatments ?? []))) return;
    draft!.factors!.treatments!.splice(i, 1);
    keepGroupOnNextAnchor = true;
    persistNow((payload) => payload.factors!.treatments!.splice(i, 1), treatmentAnchor(t.name?.trim() || "this treatment"));
  }
  // M71 P6 — standalone Pin toggle per treatment, same scoped-persist shape as deleteTreatment
  // above: mutate a clone of the last-saved `client` (never the live `draft`) and persist immediately.
  function togglePinTreatment(t: TreatmentItem) {
    if (!draft) return;
    togglePin(draft, t.id);
    if (!wasSavedThisSession(client, t.id)) return;
    persistNow((c) => togglePin(c, t.id));
  }
  function addTreatment() {
    newTreatment = { id: crypto.randomUUID(), name: "", kind: "drug", start: "" };
    editingIndex = null;
    addOpen = true;
    addMode = "photos";
    revokePendingImages();
    pendingText = "";
    identifying = false;
    identified = false;
    identifyError = null;
    savingNew = false;
    saveImageError = null;
  }
  // M103 — "+ Add entry" for one drug's row in the Medicine table: same blank-item flow as
  // addTreatment, just pre-filled with the group's name.
  function addTreatmentForName(name: string) {
    addTreatment();
    if (newTreatment) newTreatment.name = name;
  }
  // M103 — the Medicine table groups by name (groupByName), which doesn't carry the original
  // array index editModel's tagged pairs do; resolve it by id on demand, same lookup
  // attachToTreatment/togglePinTreatment already use above.
  function editIndexOf(t: TreatmentItem): number {
    return editIndexOfRow(t.id, draft?.factors?.treatments);
  }
  // M113 — attaching while editing an EXISTING row mutates the local `newTreatment` clone, same as
  // any other field on the Edit form: Cancel discards it, Save writes it back by index through the
  // normal saveNewTreatment path. Unlike attachToTreatment (card-menu Attach, which persists
  // immediately regardless of this modal), this only takes effect on Save.
  function addAttachmentToEdit() {
    if (!clientId || !newTreatment) return;
    openAttachPicker("files", async (files) => {
      try {
        const added = await attachFiles(clientId, files);
        if (newTreatment) newTreatment.attachments = appendAttachments(newTreatment.attachments, added);
      } catch (err) {
        saveImageError = err instanceof Error ? err.message : "Attaching failed — try again.";
      }
    }, DEFAULT_ATTACH_ACCEPT);
  }
  // W78 — the only place a SAVED attachment can be removed; medicine-scope save fans newTreatment's
  // attachments to every sibling unchanged, so guarding newTreatment here covers both scopes.
  function removeAttachmentFromEdit(a: Attachment) {
    if (newTreatment) saveImageError = removeAttachment(newTreatment, a.key);
  }
  $effect(() => {
    if (autoOpenAdd) {
      addTreatment();
      onAutoOpenAddConsumed?.();
    }
  });
  // M76/Phase 3 — a deep-linked treatment anchor whose owning bucket isn't the currently active one
  // would otherwise never mount under single-bucket rendering. Reverse-match it against the full
  // unfiltered, collapsed-by-name set (not editModel/model's bucket/filter-narrowed rows), resolve
  // its bucket with the same bucketOf used everywhere else, switch to it, then let the caller clear
  // pendingAnchor. No index needed — bucketOf is a pure function of one item.
  //
  // M103 — this also fires after every Save (onSaved passes the saved row's anchor through, see
  // App.svelte's navigate()), which is why editing from Medicine used to bounce you to whichever
  // temporal bucket the row now falls in: Medicine isn't a bucket, so it was never a candidate here
  // and always lost the reassignment. Medicine already shows every row regardless of date, so there's
  // nothing to reverse-match — skip the reassignment and stay put.
  // A SAVE also routes through here (persistNow -> onSaved -> navigate -> pendingAnchor), and the
  // reassignment below is wrong for that case: it resolves the bucket of the medicine's
  // representative row, so saving an edit while viewing Past threw you into Ongoing whenever that
  // drug also had a current dose period. Editing should leave you where you were looking; only a
  // real navigation (a sidebar link to a drug) should move the view to that drug's bucket.
  let keepGroupOnNextAnchor = $state(false);
  $effect(() => {
    if (!pendingAnchor) return;
    if (keepGroupOnNextAnchor) {
      keepGroupOnNextAnchor = false;
      onConsumeAnchor?.();
      return;
    }
    if (activeGroup === "medicine") {
      onConsumeAnchor?.();
      return;
    }
    const all = collapseByName(treatmentsOf(client));
    // W64 — findByAnchor, not `===`: a dose-row anchor is the medicine's plus a suffix.
    const t = findByAnchor(all, pendingAnchor, (x) => treatmentAnchor(x.name));
    if (t) {
      activeGroup = bucketOf(t, today);
      onConsumeAnchor?.();
    }
  });
  // M66 — Edit reuses the Add modal, pre-filled from a clone of the row (not the live draft item,
  // so Cancel discards without touching draft); Save below writes it back by index.
  function startEditTreatment(t: TreatmentItem, i: number, scope: FieldScope = "all") {
    newTreatment = { ...t };
    editingIndex = i;
    editScope = scope;
    editGroupName = null;
    addOpen = true;
  }
  // M-medicine-fields — the group-level Edit: Name/Reason/Kind belong to the medicine, so saving
  // writes them across EVERY dose row of that drug (matched on the pre-edit name, so a rename still
  // finds them all), rather than letting one titration step drift from its siblings.
  function startEditMedicine(g: NamedTreatmentGroup) {
    newTreatment = { ...g.rows[0] };
    editingIndex = null;
    editScope = "medicine";
    editGroupName = g.name;
    addOpen = true;
  }
  // M-medicine-dup — "Duplicate" opens the modal as an ADD pre-filled from this dose row, so the
  // common case of "same drug, new dose period" doesn't mean retyping the whole record.
  function startDuplicateTreatment(t: TreatmentItem) {
    newTreatment = duplicateTreatment(t, crypto.randomUUID());
    editingIndex = null;
    editScope = "all";
    editGroupName = null;
    addOpen = true;
  }
  // Removes the whole medicine — every dose row of it — matching what the group card represents.
  function deleteMedicine(g: NamedTreatmentGroup) {
    if (!confirm(deleteMedicinePrompt(g))) return;
    const ids = new Set(g.rows.map((r) => r.id));
    const drop = (c: Client) => removeTreatmentsById(c, ids);
    drop(draft!);
    persistNow(drop, treatmentAnchor(g.name));
  }
  // M-dose-gates-assessment — Assessment reasons over a dose that doesn't exist yet is hollow, so a
  // save only triggers it once the drug has at least one row (any bucket) with an actual doseAmount.
  // A business-rule precondition, not a staleness question — see the DAG note above saveNewTreatment's
  // two trigger call sites.
  function hasAnyDose(name: string): boolean {
    return hasAnyDoseInTreatments(name, draft?.factors?.treatments);
  }
  // The auto-trigger after a save is fire-and-forget by design (closing the modal shouldn't wait on
  // an Anthropic call) — but "fire-and-forget" used to also mean "and never find out if it failed."
  // Reuses doTranslate's own error slot, keyed the same way the template already reads it
  // (translateErrorId === g.rows[0].id), so a failure surfaces on the drug's card without adding a
  // second banner mechanism.
  function reportIfRegenFailed(pending: ReturnType<NonNullable<typeof onTriggerRegen>> | undefined, name: string) {
    // The auto-trigger fires with only a treatment name in scope, but the "Translating…" note and the
    // stale-content swap below are keyed off a row id the same way doTranslate() already keys them —
    // look the row up once, up front, so this path shows the same busy state a manual click does
    // instead of leaving the old Assessment on screen with no sign it's out of date.
    const key = name.trim().toLowerCase();
    const rowId = groupByName(draft?.factors?.treatments ?? [], today).find((g) => g.name.trim().toLowerCase() === key)
      ?.rows[0]?.id;
    if (rowId) translatingId = rowId;
    void pending
      ?.then((r) => {
        if (r?.status !== "failed" || !rowId) return;
        translateError = r.error ?? "Couldn't update the assessment.";
        translateErrorId = rowId;
      })
      .catch((e) => {
        if (!rowId) return;
        translateError = describeAiError(e);
        translateErrorId = rowId;
      })
      .finally(() => {
        if (rowId && translatingId === rowId) translatingId = null;
      });
  }
  async function saveNewTreatment() {
    if (!newTreatment || !newTreatment.name?.trim() || savingNew) return;
    saveImageError = null;
    if (pendingImages.length > 0 && clientId) {
      savingNew = true;
      try {
        mergeUploadedImages(newTreatment, await uploadPendingImages(clientId, pendingImages, {
          compressImage,
          buildAttachmentKey,
          uploadAttachment,
        }));
      } catch (err) {
        saveImageError = err instanceof Error ? err.message : "Couldn't save photos — try again.";
        savingNew = false;
        return;
      }
      savingNew = false;
    }
    const plan = planTreatmentSave({
      item: newTreatment, scope: editScope, editingIndex, editGroupName, rows: draft!.factors?.treatments ?? [],
    });
    // M57 — persists immediately; draft gets the same write so the row shows without waiting on the
    // resync round trip (which skipNextResync deliberately skips).
    applyTreatmentSave(draft!, plan);
    keepGroupOnNextAnchor = true;
    persistNow((payload) => applyTreatmentSave(payload, plan), treatmentAnchor(plan.name));
    // treatmentAssessment is keyed by the raw treatment name (leaf-regen.ts's SCOPE OVERRIDE matches
    // it against the model's dose-annotated label) and answers per (drug, phase), so no bucket branch.
    if (hasAnyDose(plan.name)) reportIfRegenFailed(onTriggerRegen?.("treatmentAssessment", [plan.name]), plan.name);
    if (plan.kind === "medicine" && plan.regenGroups) onTriggerRegen?.("treatmentGroups", undefined, true);
    cancelAddTreatment();
  }
  function cancelAddTreatment() {
    addOpen = false;
    newTreatment = null;
    editingIndex = null;
    editScope = "all";
    editGroupName = null;
    revokePendingImages();
  }

  // Read model (patient / read-only) — collapsed by name, grouped by system, AI matched with a used-set.
  const model = $derived(buildTreatmentRows(client));

  const ongoingGrouped = $derived.by(() => groupBySystem(client, model.ongoing, (r) => r.group));
  const plannedGrouped = $derived.by(() => groupBySystem(client, model.planned, (r) => r.group));
  const pastGrouped = $derived.by(() => groupBySystem(client, model.past, (r) => r.group));
  const allRows = $derived([...model.ongoing, ...model.planned, ...model.past]);
  const allGrouped = $derived.by(() => groupBySystem(client, allRows, (r) => r.group));
  const READ_VIEWS = $derived({
    medicine: { rows: allRows, grouped: allGrouped, label: "" },
    ongoing: { rows: model.ongoing, grouped: ongoingGrouped, label: "ongoing " },
    planned: { rows: model.planned, grouped: plannedGrouped, label: "planned " },
    past: { rows: model.past, grouped: pastGrouped, label: "past " },
  });
  const empty = $derived(treatmentsOf(client).length === 0);

  // M103 — Medicine's grouping, off the live draft (not `client`) so edits show immediately, same
  // as editModel above. M108 — group order is Planned/Ongoing/Past (recency of use), not entry order.
  // M-medicine-group — pinned medicines float to the top, keyed off the group's representative row
  // (the same rows[0] that decides its bucket badge), matching Pin's behavior in every other leaf.
  function groupsOf(rows: TreatmentItem[]): NamedTreatmentGroup[] {
    return sortPinnedFirst(groupByName(rows, today), (g) => g.rows[0].pinned);
  }
  const medicineGroups = $derived(groupsOf(draft?.factors?.treatments ?? []));
  // The three temporal views render the SAME per-medicine card, over just the rows their own date
  // filter admits (bucketOf, unchanged) — so Past shows a drug's concluded dose periods, Planned its
  // future ones, Ongoing the rest. Grouping after filtering is what keeps each view's table to its
  // own bucket instead of repeating the drug's whole history three times.
  const bucketedRows = $derived(partitionByBucket(draft?.factors?.treatments ?? [], today));
  // One map, so the four view branches below become one render. They were byte-identical apart from
  // which array they iterated and one adjective, which is exactly how a fix lands in three of them.
  const GROUPS = $derived({
    medicine: { groups: groupsOf(draft?.factors?.treatments ?? []), label: "", badge: true },
    ongoing: { groups: groupsOf(bucketedRows.ongoing), label: "ongoing ", badge: false },
    planned: { groups: groupsOf(bucketedRows.planned), label: "planned ", badge: false },
    past: { groups: groupsOf(bucketedRows.past), label: "past ", badge: false },
  });

  // M76/Phase 3 — which single bucket renders. Trusts activeGroup when it's a valid bucket key;
  // otherwise defaults to All — defensive only, since the real default-setting responsibility lives
  // in App.svelte's default-group effect (which defaults this tab to the same `medicine` key).
  // Guards against a stale/foreign value surviving a client switch — including the retired
  // "ungrouped", which is still what a pre-existing saved nav memory holds.
  const resolvedGroup = $derived.by(() => {
    if (activeGroup === "ongoing" || activeGroup === "planned" || activeGroup === "past") return activeGroup;
    return "medicine";
  });
</script>

{#snippet assessedSection(rows: Row[], grouped: { system: string; rows: Row[] }[] | null)}
  {#if grouped}
    {#each grouped as grp (grp.system)}
      <h4 class="ct-system">{grp.system}</h4>
      {#each grp.rows as r (r.name)}<TreatmentRow row={r} {clientId} />{/each}
    {/each}
  {:else}
    <PendingGrouping />
    {#each rows as r (r.name)}<TreatmentRow row={r} {clientId} />{/each}
  {/if}
{/snippet}


{#snippet treatmentFields(t: TreatmentItem, scope: FieldScope = "all")}
  <!-- M-medicine-fields — Name/Reason/Kind describe the MEDICINE; Start/End/dose/timing describe one
       dose period of it. Medicine's group Edit shows only the former (and writes them across every
       row of that drug), its per-entry Edit only the latter, so a titration step can't silently
       disagree with its siblings about what the drug even is. "all" keeps the original combined form
       for Add and for the temporal tabs, where a row IS the whole treatment as far as the view shows.
       M-locked-fields — Name/description/Maker/Kind are LexiTar's own reading of the label, same as
       Ingredients/Links below: always plain text, never hand-typed. The only way to change any of
       them is Clear extracted data + re-run Identify, never a per-field edit. -->
  {#if scope !== "entry"}
    <Field label="Name" wide>
      <input type="text" value={t.name} readonly aria-readonly="true" />
    </Field>
    <!-- The PRODUCT: what it is and what is in it. Medicine-level with Name/Kind, never shown at
         "entry" scope — an ingredient list does not belong to one dose period. -->
    {#if t.description}
      <Field label="Product description" wide>
        <p class="field-note">{t.description}</p>
      </Field>
    {/if}
    {#if t.maker}
      <Field label="Maker" wide>
        <p class="field-note">{t.maker}</p>
      </Field>
    {/if}
    {#if t.ingredients?.length}
      <div class="field field--wide"><span>Ingredients <em class="field-note">label amounts, per serving</em></span>
        <ul class="ing-list">
          {#each t.ingredients as ing (ing.name)}<li>{formatIngredient(ing)}</li>{/each}
        </ul>
      </div>
    {/if}
    {#if hasProductData(t)}
      <Button onclick={() => clearExtractedData(t)}>Clear extracted data</Button>
    {/if}
    {#if t.links?.length}
      <Field label="Links" wide>
        <ul class="link-list">
          {#each t.links as l (l.url)}
            <li><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a></li>
          {/each}
        </ul>
        <Button onclick={() => (t.links = undefined)}>Clear links</Button>
      </Field>
    {/if}
    <!-- Turn 2's recap — LABEL facts LexiTar read off the source, never patient-editable here. The
         patient's own quantity/frequency/time of day (turn 3, below) is entered separately and may
         differ from what the label suggests. -->
    {#if t.administration}
      {@const a = t.administration}
      <div class="field field--wide administration-recap">
        <span>Label suggests</span>
        <p class="field-note">
          {a.suggestedUnits} {a.unit}{a.suggestedUnits === 1 ? "" : "s"}/{a.suggestedFrequency}
          {#if a.containerQuantity}&middot; package contains {a.containerQuantity} {a.unit}{a.containerQuantity === 1 ? "" : "s"} total{/if}
        </p>
      </div>
    {/if}
  {/if}
  <div class="tedit-grid">
    {#if scope !== "entry"}
      <Field label="Kind">
        <input type="text" value={t.kind} readonly aria-readonly="true" />
      </Field>
    {/if}
    {#if scope !== "medicine"}
    <Field label="Amount">
      {#if t.administration}
        <em class="field-note">standard is {t.administration.suggestedUnits} {t.administration.unit}{t.administration.suggestedUnits === 1 ? "" : "s"}/{t.administration.suggestedFrequency}</em>
      {/if}
      <input type="number" step="any" placeholder="blank for a behavior" bind:value={t.doseAmount} onkeydown={(e) => advanceFromAmount(e, t)} />
    </Field>
    <Field label="Unit">
      {#if t.administration}
        <!-- Turn 3's unit is LOCKED to turn 2's inference — the patient supplies a count of THIS
             unit, never a different one. Locked to `administration` specifically, not merely
             `extracted`: an extraction that found no label serving instruction has nothing to
             lock the unit TO, so it (and a legacy hand-entered treatment) keeps the free-text
             field below instead. -->
        <input type="text" value={t.doseUnit} readonly aria-readonly="true" />
      {:else}
        <input type="text" list="dose-units" placeholder="mg, g, mL…" bind:value={t.doseUnit} bind:this={unitInput} onkeydown={advanceFromUnit} />
        <datalist id="dose-units">
          <option value="mg"></option><option value="mcg"></option><option value="g"></option>
          <option value="mL"></option><option value="IU"></option><option value="tablet"></option>
          <option value="capsule"></option>
        </datalist>
      {/if}
    </Field>
    <Field label="Frequency">
      <select bind:value={t.doseFrequency} bind:this={frequencySelect}>
        <option value={undefined}>—</option>
        <option value="day">day</option>
        <option value="week">week</option>
        <option value="month">month</option>
        <option value="as needed">as needed</option>
      </select>
    </Field>
    <!-- M104 — not yet migrated to the structured fields; shows the old free-text value so it isn't
         silently invisible while Amount/Unit/Frequency sit blank. Saving leaves it untouched unless
         Amount is filled in (see formatDose()'s fallback in treatment-bucket.ts). -->
    {#if t.dose && t.doseAmount == null}
      <p class="legacy-dose-note">Previously entered as "{t.dose}" — fill in Amount above to replace it.</p>
    {/if}
    <Field label="Time of day">
      <select bind:value={t.timingPeriod}>
        <option value={undefined}>—</option>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </Field>
    {@const conclusion = computeConclusion([t], t.administration, t.ingredients)}
    {#if isConclusion(conclusion) && conclusion.ingredientTotals.length}
      <div class="field field--wide conclusion-preview">
        <span>{PRODUCT_NAME} · Daily total</span>
        <ul class="ing-list">
          {#each conclusion.ingredientTotals as it (it.name)}<li>{formatIngredientTotal(it)}</li>{/each}
        </ul>
      </div>
    {:else if !isConclusion(conclusion)}
      {@const message = conclusionMessage(conclusion)}
      {#if message}<p class="field-note conclusion-preview">{message}</p>{/if}
    {/if}
    {/if}
  </div>
  {#if scope !== "medicine"}
    <Field label="Reason" wide>
      <div class="field-row">
        <input type="text" placeholder="e.g. joint pain, started after March visit" bind:value={t.reason} />
        <DictateButton onResult={(txt) => (t.reason = t.reason ? `${t.reason} ${txt}` : txt)} />
      </div>
    </Field>
    <div class="tedit-daterow">
      <Field label="Start">
        <input type="date" bind:value={t.start} onchange={(e) => { if (isCompleteDate((e.currentTarget as HTMLInputElement).value)) endDateInput?.focus(); }} />
      </Field>
      <Field label="End">
        <div class="end-row">
          <input type="date" bind:value={t.end} bind:this={endDateInput} />
          {#if !t.end}<Button class="end-now" title="mark discontinued today" onclick={() => (t.end = today)}>End now</Button>{/if}
        </div>
      </Field>
    </div>
  {/if}
{/snippet}


{#snippet medicineCard(g: NamedTreatmentGroup, showBadge: boolean)}
  {@const gaps = dateGaps(g.rows)}
  {@const shown = shownRows(g)}
  {@const planned = bucketOf(g.rows[0], today) === "planned"}
  {@const assessment = assessmentOf(g.rows[0])}
      <div class="med-group">
        <!-- Bespoke, not TurnCard (see TurnCard.svelte:10-21's own invariant): four sequential
             turns, not one patient beside one AI, so there is no natural pairing into TurnCard's
             two-column shape. Each block still follows its "always render something, say why if
             absent" convention by hand — LeafCard itself provides none of that for free. -->
        {#snippet medTitle()}
          <span class="ct-title-row">
            <span class="ct-drug"><HeadingAnchor anchor={treatmentAnchor(g.name)} label="Copy link to this drug">{g.name}</HeadingAnchor></span>
            {#if showBadge}<span class="bucket bucket--{bucketOf(g.rows[0], today)}">{BUCKET_LABEL[bucketOf(g.rows[0], today)]}</span>{/if}
            {#if g.rows[0].kind}<span class="med-kind">{g.rows[0].kind}</span>{/if}
          </span>
        {/snippet}
        {#snippet medPatient()}
            {#if g.rows[0].reason}<p class="med-reason">{g.rows[0].reason}</p>{/if}
            <div class="med-table-wrap">
              <table class="med-table">
                <thead>
                  <tr><th>Start</th><th>End</th><th>Dose</th><th>Timing</th><th></th></tr>
                </thead>
                <tbody>
                  {#each shown as t, idx (t.id)}
                    <tr>
                      <td data-label="Start">{t.start ? formatDay(t.start) : "—"}</td>
                      <td data-label="End">{t.end ? formatDay(t.end) : "ongoing"}</td>
                      <td data-label="Dose">{formatDose(t) || "—"}</td>
                      <td data-label="Timing">{t.timingPeriod || "—"}</td>
                      <td class="med-actions">
                        <div class="med-actbar">
                          <Button class="med-act" title="Edit this dose entry" onclick={() => startEditTreatment(t, editIndexOf(t), "entry")}>Edit</Button>
                          <Button class="med-act" title="Start a new dose entry from this one" onclick={() => startDuplicateTreatment(t)}>Duplicate</Button>
                          <Button class="del med-act" title="Delete this dose entry" onclick={() => deleteTreatment(t, editIndexOf(t))}>Delete</Button>
                        </div>
                      </td>
                    </tr>
                    <!-- The flag describes the boundary with the NEXT row, so it only makes
                         sense while that row is on screen — suppressed at the collapsed edge. -->
                    {#if idx < shown.length - 1}
                      {#if gaps[idx] === "gap"}
                        <tr class="med-flag med-gap"><td colspan="5">⚠ gap in coverage before the entry below</td></tr>
                      {:else if gaps[idx] === "overlap"}
                        <tr class="med-flag med-overlap"><td colspan="5">⚠ overlaps with the entry below</td></tr>
                      {/if}
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
            <div class="med-foot">
              {#if g.rows.length > MEDICINE_PREVIEW_ROWS}
                <Button
                  class="med-more"
                  aria-expanded={!!expandedGroups[g.name]}
                  onclick={() => (expandedGroups[g.name] = !expandedGroups[g.name])}
                >{expandedGroups[g.name] ? "⌃ Show fewer" : `⌄ Show all ${g.rows.length}`}</Button>
              {/if}
              <Button class="med-add" onclick={() => addTreatmentForName(g.name)}>+ Add entry</Button>
            </div>
        {/snippet}
        <!-- Reading order: Extracted (the label transcription) first, then the dose editor, then
             Daily total (the computed conclusion drawn from both), then Assessment last (LexiTar's
             own commentary on the treatment in the patient's context) — raw facts, then how it's
             being taken, then the math on those facts, then the interpretation of all three. -->
        {#snippet medExtracted()}
          {@const t = g.rows[0]}
          {#if t.maker}<p class="med-maker">{t.maker}</p>{/if}
          {#if t.description}<p class="med-desc">{t.description}</p>{/if}
          {#if t.ingredients?.length}
            <ul class="ing-list">
              {#each t.ingredients as ing (ing.name)}<li>{formatIngredient(ing)}</li>{/each}
            </ul>
          {/if}
          {#if t.links?.length}
            <ul class="med-links">
              {#each t.links as l (l.url)}
                <li><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a></li>
              {/each}
            </ul>
          {/if}
          {#if t.administration}
            {@const a = t.administration}
            <p class="field-note">
              Label suggests {a.suggestedUnits} {a.unit}{a.suggestedUnits === 1 ? "" : "s"}/{a.suggestedFrequency}
              {#if a.containerQuantity}&middot; package contains {a.containerQuantity} {a.unit}{a.containerQuantity === 1 ? "" : "s"} total{/if}
            </p>
          {/if}
          {#if t.extracted?.via === "photo" && t.rawCaptureAttachmentKeys?.length}
            {@const raw = (t.attachments ?? []).filter((a) => t.rawCaptureAttachmentKeys!.includes(a.key))}
            {#if raw.length}
              <div class="med-raw-capture"><AttachmentStrip attachments={raw} {clientId} {attachmentUrl} productName={PRODUCT_NAME} /></div>
            {/if}
          {:else if t.extracted?.via === "text" && t.rawCaptureText}
            <details class="med-raw-text"><summary>View original text</summary><p>{t.rawCaptureText}</p></details>
          {/if}
          <!-- The full attachment set is the drug's own — a product photo or a COA documents the
               drug, not the entry-scope dose turn, so it belongs on this label-transcription block
               rather than the dose editor. Excludes whatever's already shown above as the raw
               identify-from-photo capture, so the same thumbnail never renders twice. -->
          {@const otherAttachments = groupAttachmentsOf(g.rows).filter((a) => !t.rawCaptureAttachmentKeys?.includes(a.key))}
          {#if otherAttachments.length > 0}
            <div class="med-attachments"><AttachmentStrip attachments={otherAttachments} {clientId} {attachmentUrl} productName={PRODUCT_NAME} /></div>
          {/if}
        {/snippet}
        {#snippet medDailyTotal()}
          <!-- Every row currently ongoing for this drug contributes (an AM+PM pair is two rows,
               both live at once — see computeConclusion's own comment), never just g.rows[0]. A
               separate turn from Extracted above: that is a transcription of the label, this is a
               computed conclusion about what the patient is actually taking. -->
          {@const ongoingRows = g.rows.filter((r) => bucketOf(r, today) === "ongoing")}
          {@const conclusion = computeConclusion(ongoingRows, g.rows[0].administration, g.rows[0].ingredients)}
          {#if isConclusion(conclusion) && conclusion.ingredientTotals.length}
            <PersonaBubble persona="assistant" label={`${PRODUCT_NAME} · Daily total`}>
              <ul class="ing-list">
                {#each conclusion.ingredientTotals as it (it.name)}<li>{formatIngredientTotal(it)}</li>{/each}
              </ul>
            </PersonaBubble>
          {:else if !isConclusion(conclusion)}
            {@const message = conclusionMessage(conclusion)}
            {#if message}<p class="field-note">{message}</p>{/if}
          {/if}
        {/snippet}
        {#snippet medAssessment()}
          <!-- Assessment is LexiTar's own derived commentary (e.g. brand → active-ingredient,
               dose-appropriateness, interactions) on the treatment in the patient's overall
               context — last, since it reasons over the Extracted facts and Daily total above. -->
          {#if translatingId === g.rows[0].id}
            <!-- The old Assessment is stale the moment a dose/product edit lands — showing it as
                 current while a regen is in flight (which can take up to two minutes) reads as
                 the app just not noticing the edit. Swap it for a working note instead. -->
            <PersonaBubble persona="assistant" label={PRODUCT_NAME}>
              <p class="ct-assess translate-note">
                Reviewing {g.name}'s dosing, interactions with other treatments, and recent labs… {translateElapsed}s
              </p>
            </PersonaBubble>
          {:else if assessment}
            <PersonaBubble persona="assistant" label={PRODUCT_NAME}><p class="ct-assess">{assessment}</p></PersonaBubble>
          {:else}
            <p class="leaf-row-empty">No {PRODUCT_NAME} assessment — regenerate the Translation.</p>
          {/if}
          {#if translateErrorId === g.rows[0].id && translateError}<p class="translate-error">{translateError}</p>{/if}
        {/snippet}
        <LeafCard title={medTitle} items={groupActions(g)} pinned={!!g.rows[0].pinned} onTogglePin={() => togglePinMedicine(g)}>
          <div class="med-turns">
            <div class="rg-col leaf-side">
              {#if hasProductData(g.rows[0])}
                <PersonaBubble persona="assistant" label={`${PRODUCT_NAME} · Extracted`}>{@render medExtracted()}</PersonaBubble>
              {:else}
                <p class="leaf-row-empty">No {PRODUCT_NAME} product data extracted — use Identify to read it from a label.</p>
              {/if}
            </div>
            <div class="rg-col med-turn-patient">
              <PersonaBubble persona="owner" label="Patient">{@render medPatient()}</PersonaBubble>
            </div>
            <div class="rg-col leaf-side">{@render medDailyTotal()}</div>
            <div class="rg-col leaf-side">{@render medAssessment()}</div>
          </div>
        </LeafCard>
      </div>
{/snippet}

<div class="unified-treatment leaf-section">
  {#if canEdit && draft}
    <div class="ut-editbar">
      <div class="ut-edit-title">
        <SaveStatus {saved} />
      </div>
    </div>
    <SaveStatus error={saveError} />
    <SaveStatus error={attachError} />
    <!-- One Patient/LexiTar exchange per medicine, in every view. The Patient side is that drug's
         dose history as a table; LexiTar responds once, to the whole of it. Each bucket feeds the
         SAME card the rows that pass its own date filter, and LexiTar now answers per (drug, phase)
         through one node — so the views differ only in which rows they hold and whether the bucket
         badge is worth showing (inside a single-bucket view every card would carry the same one). -->
    {@const view = GROUPS[resolvedGroup as keyof typeof GROUPS]}
    {#if view.groups.length > 0}
      {#each view.groups as g (g.name)}{@render medicineCard(g, view.badge)}{/each}
    {:else if (draft?.factors?.treatments?.length ?? 0) > 0}
      <p class="ct-empty">No {view.label}treatments yet for {client.displayName} — add one from the sidebar.</p>
    {/if}
    {#if (draft?.factors?.treatments?.length ?? 0) === 0}
      <p class="ct-empty">No treatment yet for {client.displayName} — add one from the sidebar.</p>
    {/if}
  {:else if empty}
    <p class="ct-empty">No treatment on record for {client.displayName}.</p>
  {:else}
    <!-- Read-only: the same three buckets, all routed through assessedSection. Past used to render
         flat, losing its body-system headings even though its rows carry `group` — a second-class
         bucket for no reason. And there was no `medicine` arm at all, though resolvedGroup defaults
         to it, so a host without onSave rendered an empty page until the user picked a bucket. -->
    {@const view = READ_VIEWS[resolvedGroup as keyof typeof READ_VIEWS]}
    {#if view.rows.length > 0}
      {@render assessedSection(view.rows, view.grouped)}
    {:else}
      <p class="ct-empty">No {view.label}treatments for {client.displayName}.</p>
    {/if}
  {/if}
</div>

{#if addOpen && newTreatment}
  <Modal
    label={editScope === "medicine" ? "Edit medicine" : editScope === "entry" ? "Edit dose entry" : editingIndex !== null ? "Edit treatment" : "Add treatment"}
    onClose={cancelAddTreatment}
  >
    <div class="tedit">
      {#if editScope === "medicine"}
        <p class="tedit-scope-note">Applies to every dose entry of {editGroupName}.</p>
      {/if}
      <!-- Also shown at "medicine" scope: every supplement already on file lacks a description, and
           without this there would be no way to enrich one short of deleting and re-adding it. -->
      {#if (editingIndex === null && editScope === "all") || editScope === "medicine"}
        <!-- No "Manual" option: a brand-new treatment's entire first turn IS a capture (see
             captureRequired) — there is no other way in. A medicine-scope re-extraction on an
             EXISTING drug still offers both capture methods alongside the fields below. -->
        <div class="add-mode-toggle">
          <Button class={addMode === "photos" ? "mode active" : "mode"} onclick={() => (addMode = "photos")}>From photos</Button>
          <Button class={addMode === "text" ? "mode active" : "mode"} onclick={() => (addMode = "text")}>From text</Button>
        </div>
        {#if addMode === "photos"}
          <div class="photo-intake">
            {#if !clientId}
              <p class="ct-empty">Unlock a patient to add photos.</p>
            {:else}
              <input type="file" accept="image/*" multiple capture="environment" onchange={onPickImages} disabled={pendingImages.length >= 4} />
              {#if pendingImages.length > 0}
                <div class="photo-preview-strip">
                  {#each pendingImages as p, idx (p.previewUrl)}
                    <div class="photo-preview">
                      <img src={p.previewUrl} alt="" />
                      <Button class="photo-remove" onclick={() => removeImage(idx)}>✕</Button>
                    </div>
                  {/each}
                </div>
              {/if}
              <Button onclick={() => identifyFrom("photos")} disabled={pendingImages.length === 0 || identifying}>
                {identifying ? "Identifying…" : "Identify from photos"}
              </Button>
              <SaveStatus error={identifyError} />
              {#if identified}<p class="ai-tag">✓ {PRODUCT_NAME}-inferred from photo — your own Amount/Frequency/Time of day stay yours to enter below.</p>{/if}
            {/if}
          </div>
        {:else if addMode === "text"}
          <div class="text-intake">
            <textarea
              rows="8"
              bind:value={pendingText}
              placeholder="Paste the product's description, ingredient list, and any links…"
            ></textarea>
            <Button onclick={() => identifyFrom("text")} disabled={!pendingText.trim() || identifying}>
              {identifying ? "Reading…" : "Extract from text"}
            </Button>
            <SaveStatus error={identifyError} />
            {#if identified}<p class="ai-tag">✓ {PRODUCT_NAME}-inferred from text — ingredient amounts are label facts; your own Amount/Frequency/Time of day stay yours to enter below.</p>{/if}
          </div>
        {/if}
        {#if captureRequired}
          <p class="ct-empty">Add a photo or paste text above, then Identify, to continue.</p>
        {/if}
      {/if}
      {#if !captureRequired}
        {@render treatmentFields(newTreatment, editScope)}
      {/if}
      {#if editScope === "medicine" || (editScope === "all" && editingIndex !== null)}
        <!-- M113 — attach a photo/document to an EXISTING treatment. The new-record "From photos"
             flow above is a different feature (AI-guesses name/kind); this is plain attachment,
             matching what Ongoing/Planned/Past's card ⋮ menu already offers.
             Never shown at "entry" scope: like Name/Reason/Kind, an attachment describes the drug,
             so editing one dose period must not look like the place to change the drug's photos. -->
        <div class="field tedit-attachments">
          <span>Attachments</span>
          <AttachmentStrip attachments={attachmentsOf(newTreatment)} {clientId} {attachmentUrl} productName={PRODUCT_NAME} onRemove={removeAttachmentFromEdit} />
          <Button onclick={addAttachmentToEdit}>+ Add photo/file</Button>
        </div>
      {/if}
      <SaveStatus error={saveImageError} />
      <div class="tedit-actions">
        <Button onclick={cancelAddTreatment}>Cancel</Button>
        <Button primary onclick={saveNewTreatment} disabled={!newTreatment.name?.trim() || savingNew}>
          {savingNew ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .ct-system { margin: 1rem 0 0.6rem; font-size: 0.9rem; font-weight: 700; color: var(--accent); }
  .ct-title-row { display: inline-flex; align-items: baseline; gap: 0.45rem; }
  .ct-drug { font-weight: 600; font-size: 0.92rem; color: var(--fg); }
  .ct-dose { margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--muted); }
  .ct-assess { margin: 0; font-size: 0.86rem; line-height: 1.45; color: var(--fg); }
  .ct-empty { color: var(--muted); font-size: 0.88rem; }

  /* M-medicine-group — the dose history is a TABLE inside the Patient bubble (one row per titration
     step, newest first), so continuity, dose trajectory and gaps read at a glance rather than as a
     stacked dump. Left-aligned against the bubble's own right-alignment — a table of dates/doses is
     scanned column-wise, so it needs a consistent left edge. */
  .med-group { margin-bottom: 2rem; }
  /* Bespoke stack, not .rg-grid: four turns, not two, so alignment is set per block instead of via
     .rg-grid's :first-child/:last-child pair. .leaf-side (LeafCard's global left/AI alignment) is
     reused as-is; .med-turn-patient is its mirror, since LeafCard has no standalone right/patient
     equivalent (only ever needed inside a two-child .rg-grid before now). */
  .med-turns { display: flex; flex-direction: column; row-gap: 0.5rem; }
  .med-turn-patient { align-self: flex-end; max-width: var(--rg-side-w); text-align: right; }
  /* The dose table stays right-aligned at the conversational --rg-side-w inset, like every other
     leaf — the table earns its fit by not wasting width instead of by taking the whole card. */
  .med-reason { margin: 0 0 0.4rem; font-size: 0.82rem; color: var(--muted); }
  .med-kind { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .med-table-wrap { border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; }
  .med-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; text-align: left; }
  .med-table th {
    background: var(--card); text-align: left; font-size: 0.68rem;
    text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600;
    padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); white-space: nowrap;
  }
  .med-table td { padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); color: var(--fg); white-space: nowrap; }
  .med-table tbody tr:last-child td { border-bottom: none; }
  /* The actions column is exactly as wide as its three buttons; `width: 1%` is the standard way to
     tell a width:100% table "give the slack to the other columns, not to me", and the cell still
     can't shrink below its content. The flex row lives in an inner div on purpose — making the <td>
     itself the flex container destroys its intrinsic table sizing, which collapsed this column to
     16px and let the buttons spill ~170px past it. */
  .med-table th:last-child, .med-table td.med-actions { width: 1%; }
  .med-actbar { display: flex; gap: 0.3rem; }
  .med-flag td { font-size: 0.74rem; font-weight: 600; padding: 0.2rem 0.5rem; white-space: normal; }
  .med-gap td { background: var(--warn-band); color: var(--warn); }
  .med-overlap td { background: var(--alert-band); color: var(--alert); }
  :global(.med-act) { font-size: 0.72rem; padding: 0.15rem 0.45rem; }
  /* The medicine's own attachments, below its dose table — one strip for the drug, not one per row. */
  .med-attachments { margin-top: 0.5rem; }
  .med-links { list-style: none; margin: 0.4rem 0 0; padding: 0; font-size: 0.8rem; }
  .med-desc { margin: 0 0 0.4rem; font-size: 0.86rem; line-height: 1.45; color: var(--fg); }
  .med-maker { margin: 0 0 0.2rem; font-size: 0.78rem; font-weight: 600; color: var(--muted); }
  .med-raw-capture, .med-raw-text { margin-top: 0.5rem; }
  .med-raw-text summary { cursor: pointer; font-size: 0.78rem; color: var(--muted); }
  .med-raw-text p { margin: 0.3rem 0 0; font-size: 0.82rem; white-space: pre-wrap; color: var(--fg); }
  .text-intake textarea { width: 100%; font: inherit; padding: 0.4rem; }
  .field-note { font-weight: 400; font-style: italic; color: var(--muted); }
  .ing-list, .link-list { margin: 0.2rem 0; padding-left: 1.1rem; font-size: 0.85rem; }
  /* Turn 2's recap, in the edit form — same LexiTar-sourced accent as .conclusion-preview below. */
  .administration-recap > span { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--p-assistant); }
  .administration-recap p { margin: 0.2rem 0 0; }

  .med-foot { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-top: 0.5rem; }
  :global(.med-more), :global(.med-add) { font-size: 0.8rem; }
  :global(.med-add) { margin: 0; }
  /* Translate feedback renders next to the bubble it belongs to — a single page-level line was
     off-screen for any row below the fold, which read as "the button does nothing". */
  .translate-note { margin: 0.3rem 0 0; font-size: 0.8rem; color: var(--muted); font-style: italic; }
  .translate-error { margin: 0.3rem 0 0; font-size: 0.8rem; color: var(--alert); }

  /* Phone — five columns cannot honestly fit 375px: squeezing them either forces a sideways scroll
     or crushes the action buttons to one letter per line. So below 560px the table stops behaving
     like a table and each dose entry becomes a stacked block, every cell labelled from its
     data-label. No column is dropped (a dose audit that hides its dates isn't one) and nothing
     scrolls sideways — the entry simply reads top-to-bottom. */
  @media (max-width: 560px) {
    .med-table-wrap { overflow-x: visible; }
    .med-table, .med-table tbody, .med-table tr, .med-table td { display: block; width: auto; }
    .med-table thead { display: none; }
    .med-table tr { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); }
    .med-table tbody tr:last-child { border-bottom: none; }
    .med-table td {
      border-bottom: none; padding: 0.1rem 0; white-space: normal;
      display: flex; gap: 0.5rem; align-items: baseline;
    }
    .med-table td[data-label]::before {
      content: attr(data-label);
      flex: 0 0 4.2rem;
      font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--muted); font-weight: 600;
    }
    /* The flag/attachment rows span the whole entry — they have no label column to align to. */
    .med-flag td { display: block; }
    .med-flag { padding: 0; }
    .med-table td.med-actions { width: auto; padding-top: 0.3rem; display: block; }
    .med-actbar { gap: 0.35rem; flex-wrap: wrap; }
    :global(.med-act) { font-size: 0.72rem; padding: 0.2rem 0.5rem; }
    .med-foot { flex-wrap: wrap; }
    .ct-title-row { flex-wrap: wrap; row-gap: 0.2rem; }
    .med-group { margin-bottom: 1.4rem; }
  }

  /* W34 — in-place treatment CRUD (no Edit toggle; the editable list is the provider's default view). */
  .tedit-actions { display: flex; align-items: center; gap: 0.4rem; }

  .tedit-scope-note { margin: 0 0 0.6rem; font-size: 0.82rem; color: var(--muted); }
  .tedit-top { display: flex; align-items: center; justify-content: space-between; }
  .tedit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.7rem 0.8rem; }
  .legacy-dose-note { grid-column: 1 / -1; margin: 0; font-size: 0.78rem; font-style: italic; color: var(--muted); }
  /* Turn 4, live: same grid, so it needs the same full-width span legacy-dose-note above uses. */
  .conclusion-preview { grid-column: 1 / -1; margin: 0; }
  .conclusion-preview > span { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--p-assistant); }
  .tedit-daterow { display: flex; gap: 0.8rem; flex-wrap: wrap; }
  .tedit-daterow :global(.field) { flex: 1 1 200px; min-width: 160px; }
  .end-row { display: flex; gap: 0.4rem; align-items: center; }
  .bucket { display: inline-block; padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
  .bucket--ongoing { background: var(--band); color: var(--accent); }
  .bucket--planned { background: var(--warn-band); color: var(--warn); }
  .bucket--past { background: var(--border); color: var(--muted); }
  .tedit-attachments { margin: 0.7rem 0; align-items: flex-start; }
  .tedit-attachments :global(.btn) { align-self: flex-start; font-size: 0.82rem; padding: 0.35rem 0.7rem; margin-top: 0.2rem; }
  /* W64 — 0.95rem/6px/0.55rem-0.7rem, matching Allergies, Family, Personalization and
     HealthReports. This editor alone rendered its inputs at 1rem with a 7px radius: the one
     duplicated rule body among ~60 that was actually visible to a user. */
  input, select {
    font: inherit; font-size: 0.95rem; color: var(--fg); padding: 0.55rem 0.7rem;
    border: 1px solid var(--border); border-radius: 6px; background: white; width: 100%;
    box-sizing: border-box;
  }

  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--band); }

  .btn.done { color: var(--accent); border-color: var(--accent); font-size: 0.8rem; padding: 0.3rem 0.75rem; }
  .btn.done:hover { background: var(--band); }
  :global(.btn.del) { color: var(--muted); font-size: 0.8rem; padding: 0.3rem 0.75rem; }
  :global(.btn.del):hover { color: var(--alert); border-color: var(--alert); }
  :global(.btn.end-now) { padding: 0.35rem 0.6rem; font-size: 0.8rem; white-space: nowrap; }
  .add-mode-toggle { display: flex; gap: 0.4rem; margin-bottom: 0.4rem; }
  :global(.btn.mode) { font-size: 0.82rem; padding: 0.35rem 0.8rem; }
  :global(.btn.mode.active) { border-color: var(--accent); background: var(--band); color: var(--accent); font-weight: 600; }
  .photo-intake { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); margin-bottom: 0.3rem; }
  .photo-preview-strip { display: flex; gap: 0.5rem; overflow-x: auto; padding: 0.2rem 0; }
  .photo-preview { position: relative; flex: 0 0 auto; }
  .photo-preview img { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); display: block; }
  :global(.photo-remove) {
    position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%;
    padding: 0; font-size: 0.7rem; line-height: 1; display: flex; align-items: center; justify-content: center;
    background: var(--bg); border: 1px solid var(--border);
  }
  .ai-tag { color: var(--p-assistant); font-size: 0.8rem; font-weight: 600; margin: 0; }
  input[readonly] { background: var(--band); color: var(--muted); cursor: not-allowed; }

  /* Print the treatment content as read matter — no editor chrome (default rows are bubbles). */
  @media print {
    .ut-editbar { display: none !important; }
  }</style>
