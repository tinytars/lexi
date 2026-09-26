<script lang="ts">
  import type { Client, SourceRecord, DiseaseEntry, NoteAttachment } from "./types";
  import PersonaBubble, { type BubbleAction } from "@tinytars/frame/PersonaBubble.svelte";
  import LeafCard from "@tinytars/frame/LeafCard.svelte";
  import { removeSource, updateSource, type SourceEditPatch } from "@pablotech/akesi/report-merge";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import { reportAnchor, findByAnchor } from "./anchor";
  import { reportSystemLookup } from "./report-sidebar-groups";
  import { reportTitleOf, reportDateOf, REPORT_KIND_LABEL } from "@pablotech/akesi/report-title";
  import { filterByGroup } from "@tinytars/frame/group-filter";
  import { ALL_GROUP_KEY } from "./sidebar-labels";
  import { formatDay } from "@pablotech/akesi/dates";
  import { createDraftSync, createPersistNow } from "./draft-sync.svelte";
  import Modal from "@tinytars/frame/Modal.svelte";
  import Button from "@tinytars/frame/Button.svelte";
  import Field from "@tinytars/frame/Field.svelte";
  import FormGrid from "@tinytars/frame/FormGrid.svelte";
  import ModalActions from "@tinytars/frame/ModalActions.svelte";
  import SaveStatus from "@tinytars/frame/SaveStatus.svelte";
  import type { Permalink } from "./permalink";
  import { sortPinnedFirst } from "./pin-sort";
  import { cellPin, type PinItem } from "./body-pin";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";
  import { attachmentUrl, fetchAttachmentBytes } from "./attachment-store";
  import ReportCell from "./ReportCell.svelte";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import AttachmentViewer from "@tinytars/frame/AttachmentViewer.svelte";
  import type { Attachment } from "./types";

  // W18 follow-up: the patient's imported source files, downloadable via the bearer-guarded /api/raw.
  // W20 POC: rendered as a persona-mapped grid — each Hospital report (source) aligned row-by-row with
  // the diagnosis LexiTar extracted from it (DiseaseEntry.sourceId === SourceRecord.id). Hand-entered
  // diseases (no sourceId) show as Patient rows. M66 P3 — a report's own fields (studyType/date) plus
  // its linked DiseaseEntry rows are edited together, via the ✎ modal.
  interface Props {
    client: Client;
    clientId?: string | null;
    // W34 — deleting a report in place removes the source and everything it produced (its diagnoses
    // + extracted markers), leaving a tombstone, and persists through the shell's saveEdits → saveVault
    // path. M51 — patients can delete their own reports too (owner call). M56 — delete persists
    // immediately after confirm(), scoped to just that report. There's no add UI for reports (a
    // report only ever arrives via ingest); M66 P3 added an edit modal (✎) for existing ones.
    onSave?: (updated: Client) => void;
    onSaved?: (anchor: string) => void;
    onTriggerRegen?: (key: string) => void;
    saved?: boolean;
    saveError?: string | null;
    // M70/Phase 0 — plumbing only; wired to a "Chat" button in a later phase.
    onStartChat?: (pl: Permalink) => void;
    // M-annotate — this report's "Annotate" menu item hands its attachment up to the shell.
    onCreateNote?: (attachment: NoteAttachment) => void;
    activeGroup?: string | null;
    pendingAnchor?: string | null;
    onConsumeAnchor?: () => void;
    // W62 P7 — the report's own ★, the same SourceRecord.pinned the sidebar row writes. Distinct
    // from the per-diagnosis pins below (DiseaseEntry.pinned): a report carries several diagnoses,
    // so the two levels are different records and both are kept. The card's star pins the report;
    // a bubble's star pins one diagnosis inside it.
    onPin?: PinItem;
  }
  let {
    client, clientId = null, onSave, onSaved, onTriggerRegen, saved = false, saveError = null, onStartChat, onCreateNote,
    activeGroup = $bindable(null), pendingAnchor = null, onConsumeAnchor, onPin,
  }: Props = $props();

  const canEdit = $derived(!!onSave);

  // M96 Phase 4 — skipNextResync (inside createDraftSync) swallows the *next* client change of any
  // origin, not just this component's own echo; if an unrelated concurrent client update (e.g. a
  // background /api/leaf-regen response) coalesces into that same swallowed change, a
  // newly-ingested report could sit in the live `client` prop without ever reaching `draft`, until
  // some later change forces a real resync. `sources` (below) sidesteps this by reading
  // `client.sources` directly instead of `draft` — reports only ever arrive via ingest (no
  // client-side Add path), so this local set only needs to track optimistic removals, not additions.
  let pendingDeletedSourceIds = $state<Set<string>>(new Set());

  const ds = createDraftSync(() => client, (c) => structuredClone($state.snapshot(c)) as Client, () => saveError, () => canEdit);
  const draft = $derived(ds.draft);
  const persistNow = createPersistNow(ds, () => client, onSave, onSaved);

  // M56 — persists immediately, scoped to just this item (see Study.svelte's deleteEntry for the
  // full rationale): the network payload runs removeSource against a clone of the last-saved
  // `client`, never the live `draft`, so another in-progress edit elsewhere can't be swept in.
  function deleteReport(s: SourceRecord) {
    if (!draft) return;
    const n = diseasesForSource(s.id).length;
    const also = n > 0 ? ` and the ${n} diagnosis${n > 1 ? "es" : ""} it produced` : "";
    if (!confirm(`Remove “${s.originalName}”${also}? Its extracted markers are removed too. This can't be undone.`)) return;
    // surviving=[] — the browser doesn't hold other sources' processed rows; a corroborated reading a
    // survivor also measured is re-added on the next CLI re-fold. R2/file cleanup is the reconcile's job.
    removeSource(draft, s.id, [], new Date().toISOString().slice(0, 10));
    cancelEditReport();
    pendingDeletedSourceIds = new Set([...pendingDeletedSourceIds, s.id]);
    // M57 — saveEdits applies optimistically before its network PUT, so a concurrent immediate-
    // persist is always safe to fire (see App.svelte's saveEdits).
    if (!client.sources?.some((x) => x.id === s.id)) return; // added this session, never saved
    persistNow((payload) => removeSource(payload, s.id, [], new Date().toISOString().slice(0, 10)), reportAnchor(s.id));
  }

  // The finer of the two pin levels (see `onPin` in Props for the coarser one): this pins a single
  // DiseaseEntry inside a report, while the card's ★ pins the SourceRecord the report itself is.
  // They are separate records on purpose — a report carries several diagnoses — and neither read
  // implies the other.
  // M71 P6 — standalone Pin toggle per diagnosis, same scoped-persist shape as deleteReport above:
  // mutate a clone of the last-saved `client` (never the live `draft`) and persist immediately.
  // Diseases have no stable identity before M71 P6's `id` field, so this locates by id rather than
  // by name/index the way App.svelte's toggleWatchlist locates markers.
  function togglePinDisease(d: DiseaseEntry) {
    if (!draft) return;
    const flip = (c: Client) => {
      const match = c.factors?.diseases?.find((x) => x.id === d.id);
      if (match) match.pinned = !match.pinned;
    };
    flip(draft);
    if (!client.factors?.diseases?.some((x) => x.id === d.id)) return; // added this session, never saved
    persistNow(flip);
  }

  // M-annotate — mirrors ChatTab.svelte's buildAttachment: a self-contained permalink + preview
  // back to this report, using the same anchor the "Chat" item above already builds.
  function buildAttachment(s: SourceRecord): NoteAttachment {
    return buildNoteAttachment(
      "report",
      { client: clientId ?? undefined, tab: "labs", section: "healthReports", anchor: reportAnchor(s.id) },
      { title: reportTitleOf(s), subtitle: `${reportDateOf(s)} · ${REPORT_KIND_LABEL[s.kind]}`, tag: "Reports" },
    );
  }

  // W46 Phase 2 — canonical Edit → Chat → Annotate → Download → Delete order via the shared
  // leaf-actions contract. Fixes a read-only-viewer bug: Annotate used to be pushed outside the
  // `canEdit` guard, so a viewer with no edit rights got a menu of only Annotate + Download — Edit/
  // Chat/Annotate/Delete now all gate on the same `canEdit` (Download alone is always view-safe).
  function rowActions(s: SourceRecord): BubbleAction[] {
    return standardLeafActions({
      edit: canEdit ? () => openEditReport(s) : undefined,
      chat: canEdit ? () => onStartChat?.({ client: clientId ?? undefined, tab: "labs", section: "healthReports", anchor: reportAnchor(s.id) }) : undefined,
      annotate: canEdit && onCreateNote ? () => onCreateNote!(buildAttachment(s)) : undefined,
      preview: clientId ? () => (viewerSource = s) : undefined,
      // Download's icon flips to a spinner glyph mid-request (downloadingId), which the fixed
      // `download` slot doesn't support — built directly as an `extra` item instead.
      extra: [{
        key: "download", icon: downloadingId === s.id ? "…" : "⤓", label: "Download",
        title: "Download original report", onClick: () => downloadRaw(s),
      }],
      delete: canEdit ? () => deleteReport(s) : undefined,
    });
  }

  // M66 P3 — report edit modal: pre-filled from the SourceRecord fields reportTitleOf() reads plus the
  // linked DiseaseEntry rows (diseasesForSource). dateKeyOf targets whichever field reportDateOf() would
  // read for this record's kind, so editing "date" edits the field actually shown/sorted-by.
  function dateKeyOf(s: SourceRecord): "studyDate" | "dateEnd" | "dateStart" {
    if (s.kind === "imaging") return "studyDate";
    return s.dateEnd != null ? "dateEnd" : "dateStart";
  }
  let editSource = $state<SourceRecord | null>(null);
  let editForm = $state<{ studyType: string; date: string } | null>(null);
  let editDx = $state<{ id: string; diagnostic: string; date: string; summary: string; icdCodes: string }[]>([]);
  function openEditReport(s: SourceRecord) {
    editSource = s;
    editForm = { studyType: s.studyType ?? "", date: s[dateKeyOf(s)] ?? "" };
    editDx = diseasesForSource(s.id).map((d) => ({
      id: d.id,
      diagnostic: d.diagnostic,
      date: d.date,
      summary: d.summary ?? "",
      icdCodes: (d.icdCodes ?? []).join(", "),
    }));
  }
  function cancelEditReport() {
    editSource = null;
    editForm = null;
    editDx = [];
  }
  function saveEditReport() {
    if (!editSource || !editForm || !draft) return;
    const s = editSource;
    const patch: SourceEditPatch = {
      dateKey: dateKeyOf(s),
      date: editForm.date.trim(),
      studyType: s.kind === "imaging" ? editForm.studyType.trim() : undefined,
    };
    const dxPatches = editDx.map((d) => ({
      id: d.id,
      diagnostic: d.diagnostic,
      date: d.date,
      summary: d.summary,
      icdCodes: d.icdCodes.split(",").map((c) => c.trim()).filter(Boolean),
    }));
    updateSource(draft, s.id, patch, dxPatches);
    if (client.sources?.some((x) => x.id === s.id)) {
      persistNow((payload) => updateSource(payload, s.id, patch, dxPatches), reportAnchor(s.id));
    }
    onTriggerRegen?.("diseaseResults");
    cancelEditReport();
  }



  // M55 — while a draft exists, these read off it (so a queued delete disappears immediately); a
  // read-only host with no onSave (draft never populates) reads straight off the live client.
  const activeClient = $derived(canEdit && draft ? draft : client);
  const diseases = $derived(activeClient.factors?.diseases ?? []);
  const diseasesForSource = (id: string): DiseaseEntry[] => sortPinnedFirst(diseases.filter((d) => d.sourceId === id));

  // M96 Phase 4 — sources reads live `client` directly (not `draft`/`activeClient`), filtered by
  // the local pending-delete set: a newly-ingested report always renders by construction, since
  // this no longer depends on the resync effect catching up. Diagnoses/pin state (diseasesForSource,
  // below) still read off `activeClient` — out of scope for this fix (see plan doc §D).
  // W62 — sortPinnedFirst to match the sidebar. reportSidebarRows applies it (sidebar-leaf-rows.ts)
  // and this did not, so pinning a report moved its sidebar row to the top while the body kept it
  // in date order — the same report in two places, in two different positions.
  const sources = $derived(
    sortPinnedFirst(
      [...(client.sources ?? [])]
        .filter((s) => !pendingDeletedSourceIds.has(s.id))
        .sort((a, b) => reportDateOf(b).localeCompare(reportDateOf(a))),
    ),
  );
  // W62 — the live bug: report-sidebar-groups.ts emits a row per body system, and this component
  // declared activeGroup, destructured it, and never read it — so selecting a system did nothing but
  // scroll. Same defect as Markers/Analysis, same shared rule (group-filter.ts). The system of a
  // report comes from reportSystemLookup, the SAME function the sidebar groups by, so the two cannot
  // disagree about where a report lives. An untagged report matches no system row and is reachable
  // under All, exactly as the sidebar presents it.
  const systemOfReport = $derived(reportSystemLookup(client));
  const shownSources = $derived(
    filterByGroup(sources, activeGroup, (s) => {
      const system = systemOfReport(s.id);
      return system ? `system:${system}` : undefined;
    }, ALL_GROUP_KEY),
  );

  // A permalink to a report in a system that isn't the active one would never mount under
  // single-system rendering. Reverse-match and switch, mirroring TestsToConsider/FutureTreatment.
  $effect(() => {
    if (!pendingAnchor) return;
    const hit = findByAnchor(sources, pendingAnchor, (s) => reportAnchor(s.id));
    const system = hit && systemOfReport(hit.id);
    if (system) {
      activeGroup = `system:${system}`;
      onConsumeAnchor?.();
    }
  });

  const hasAny = $derived(
    sources.length > 0 || diseases.some((d) => !d.sourceId) || (activeClient.pendingUploads?.length ?? 0) > 0,
  );
  const patientDiseases = $derived(diseases.filter((d) => !d.sourceId));
  // W15/2 — browser uploads awaiting CLI processing ("~24h"). No diagnoses yet.
  const pendingUploads = $derived(
    [...(activeClient.pendingUploads ?? [])].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
  );

  let rawError = $state<string | null>(null);
  let downloadingId = $state<string | null>(null);

  // W46 Phase 5 — the report's raw key, shared by the thumbnail/viewer's attachmentUrl() and
  // downloadRaw()'s own fetch below (same /api/raw/{id}/{file} endpoint either way).
  function sourceKey(s: SourceRecord): string {
    return s.file.split("/").pop()!;
  }
  function sourceAttachment(s: SourceRecord): Attachment {
    return { key: sourceKey(s), name: s.originalName, mediaType: s.file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream", bytes: 0, addedAt: s.importedAt };
  }
  let viewerSource = $state<SourceRecord | null>(null);

  async function downloadRaw(s: SourceRecord) {
    if (!clientId) { rawError = "Unlock a patient to download original files."; return; }
    rawError = null;
    downloadingId = s.id;
    try {
      const file = s.file.split("/").pop()!;
      // The download is the PLAINTEXT file the patient gave us, not the envelope R2 holds — so it
      // goes through the same fetch-and-decrypt every other surface uses (attachment-blob.ts).
      let bytes: Uint8Array;
      try {
        bytes = await fetchAttachmentBytes(clientId, file);
      } catch (e) {
        rawError = `Couldn't download “${s.originalName}” (${(e as Error).message}).`;
        return;
      }
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      const a = document.createElement("a");
      a.href = url;
      a.download = s.originalName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      rawError = (e as Error).message;
    } finally {
      downloadingId = null;
    }
  }
</script>

<div class="health-reports leaf-section">
  {#if rawError}<p class="cr-error">{rawError}</p>{/if}

  {#if canEdit && draft}
    <div class="cr-editbar">
      <div class="ce-title">
        <SaveStatus {saved} />
      </div>
    </div>
    <SaveStatus error={saveError} />
  {/if}

  {#if !hasAny}
    <p class="leaf-empty">No health reports on record for {client.displayName}.</p>
  {:else}
    {#each pendingUploads as p (p.id)}
      <LeafCard dashed>
        <div class="pending-row">
          <span class="pending-badge">Processing</span>
          <div class="pending-body">
            <div class="cr-title">{p.originalName}</div>
            <p class="pending-note">Uploaded {p.uploadedAt.slice(0, 10)} — being processed into this record, usually within ~24&nbsp;hours.</p>
          </div>
        </div>
      </LeafCard>
    {/each}

    {#each shownSources as s (s.id)}
      {@const pin = cellPin(client, "report", s.id, onPin)}
      <ReportCell
        view={{ source: s, diagnoses: diseasesForSource(s.id) }}
        items={rowActions(s)}
        pinned={pin?.pinned ?? false}
        onTogglePin={pin?.onTogglePin}
        onTogglePinDiagnosis={canEdit ? togglePinDisease : undefined}
        {clientId}
        thumbnailUrl={clientId ? () => attachmentUrl(clientId, sourceKey(s)) : undefined}
        onOpenAttachment={() => (viewerSource = s)}
      />
    {/each}

    {#if patientDiseases.length > 0}
      <h4 class="cr-subhead">Self-reported conditions</h4>
      {#each patientDiseases as d (d.id)}
        <LeafCard>
          <div class="rg-grid">
            <p class="cr-selfnote">No source report — entered by the patient.</p>
            <!-- W63 — .rg-col is LeafCard's :global rule; this block used to lean on a local
                 .rg-dx copy of it that lived in this file only for the report cell above. -->
            <div class="rg-col">
              <PersonaBubble
                persona="owner"
                label="Patient"
                meta={d.date ? formatDay(d.date) : undefined}
                pinned={!!d.pinned}
                onTogglePin={canEdit ? () => togglePinDisease(d) : undefined}
              >
                <div class="cr-dx">{d.diagnostic}</div>
              </PersonaBubble>
            </div>
          </div>
        </LeafCard>
      {/each}
    {/if}
  {/if}
</div>

{#if editSource && editForm}
  <Modal label="Edit report" onClose={cancelEditReport} wide>
    <div class="cr-edit-modal">
      <div class="cr-edit-kind">{REPORT_KIND_LABEL[editSource.kind]} report</div>
      <FormGrid>
        {#if editSource.kind === "imaging"}
          <Field label="Study type"><input type="text" placeholder="e.g. CT chest" bind:value={editForm.studyType} /></Field>
        {/if}
        <Field label="Date"><input type="date" bind:value={editForm.date} /></Field>
      </FormGrid>
      {#if editDx.length > 0}
        <h4 class="cr-edit-subhead">Linked diagnoses</h4>
        {#each editDx as d, i (i)}
          <div class="cr-edit-dx">
            <FormGrid>
              <Field label="Diagnostic">
                <div class="field-row">
                  <input type="text" bind:value={d.diagnostic} />
                  <DictateButton onResult={(t) => (d.diagnostic = d.diagnostic ? `${d.diagnostic} ${t}` : t)} />
                </div>
              </Field>
              <Field label="Date"><input type="date" bind:value={d.date} /></Field>
              <Field label="ICD codes"><input type="text" placeholder="comma-separated, e.g. I25.10" bind:value={d.icdCodes} /></Field>
            </FormGrid>
            <Field label="Summary">
              <div class="field-row">
                <textarea rows="2" bind:value={d.summary}></textarea>
                <DictateButton onResult={(t) => (d.summary = d.summary ? `${d.summary} ${t}` : t)} />
              </div>
            </Field>
          </div>
        {/each}
      {/if}
      <ModalActions>
        <Button onclick={cancelEditReport}>Cancel</Button>
        <Button primary onclick={saveEditReport}>Save</Button>
      </ModalActions>
    </div>
  </Modal>
{/if}

{#if viewerSource && clientId}
  <AttachmentViewer attachments={[sourceAttachment(viewerSource)]} index={0} {clientId} {attachmentUrl} onClose={() => (viewerSource = null)} />
{/if}

<style>
  .cr-title { font-weight: 600; font-size: 1rem; color: var(--fg); }
  .cr-dx { font-weight: 600; font-size: 0.95rem; color: var(--fg); }
  .cr-subhead { margin: 1.25rem 0 0.75rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 700; }
  .cr-selfnote { color: var(--muted); font-style: italic; font-size: 0.85rem; margin: 0; align-self: center; }
  .cr-error { color: var(--alert); font-size: 0.85rem; margin: 0 0 0.7rem; }
  .pending-row { display: flex; align-items: flex-start; gap: 0.6rem; padding: 0.3rem; }
  .pending-badge { flex: none; font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.45rem; margin-top: 0.15rem; }
  .pending-body { min-width: 0; }
  .pending-note { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.84rem; line-height: 1.45; }

  /* M55 — in-place CRUD editbar + per-row open state (mirrors Study/UnifiedTreatment). */

  /* M98 P3 — shell shared via app.css; this component's gap is a real, intentional variance. */
  .cr-edit-modal { gap: 0.9rem; }
  .cr-edit-kind { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 700; }
  .cr-edit-subhead { margin: 0; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 700; }
  .cr-edit-dx { display: flex; flex-direction: column; gap: 0.6rem; border: 1px solid var(--border); border-radius: 8px; padding: 0.7rem 0.9rem; }
  input, textarea {
    font: inherit; font-size: 0.95rem; color: var(--fg);
    padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: white; width: 100%; box-sizing: border-box;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--band); }

  @media print { .cr-editbar { display: none !important; } }</style>
