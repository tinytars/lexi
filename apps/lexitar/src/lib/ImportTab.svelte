<script lang="ts">
  // W15/1 — bring a clinical report into the vault from the browser. Drop a PDF →
  // hash + dedup client-side → /api/extract reads it server-side (the vault never
  // leaves the browser; only the report does) → fold into a clone → preview → commit
  // (PUT the raw original + save the vault). The per-report diagnoses land in Clinical
  // Reports immediately; the Finding goes stale (● chips) for an on-demand refresh.
  //
  // W15/2 — any non-PDF (lab xlsx, DEXA, scale, unknown) is ACCEPTED, not rejected:
  // the raw bytes go to R2 + a pending entry to the vault, and the CLI processes it
  // out of band ("~24h"). Same hash/dedup/PUT/save spine, no /api/extract call.
  import type { Client, PendingUpload } from "./types";
  import { classifyUpload, type FoldResult, type SourceFoldResult } from "./import-flow";
  import { putRaw, countPdfPages } from "./attachment-store";
  import { PRODUCT_NAME } from "./brand";
  import { ABILITY_UNAVAILABLE, supports } from "./model-ability";

  // Spreadsheets and device exports are parsed in the browser and need no model at all, so a
  // deployment whose model can't read documents keeps importing those — it loses only the PDF path.
  const pdfImport = supports("extract", "documents");

  let {
    client,
    clientId,
    onImported,
  }: {
    client: Client | null;
    clientId: string | null;
    onImported: (updated: Client, reportId?: string) => Promise<void>;
  } = $props();

  type Status = "idle" | "reading" | "extracting" | "preview" | "committing" | "done" | "duplicate" | "error";
  let status = $state<Status>("idle");
  let kind = $state<"report" | "source" | "pending">("report");
  let fileName = $state("");
  let errorMsg = $state("");
  let dupOf = $state<{ name: string; when: string } | null>(null);
  let fold = $state<FoldResult | null>(null);
  let srcFold = $state<SourceFoldResult | null>(null);
  let pending = $state<{ upload: PendingUpload; client: Client } | null>(null);
  let bytes: Uint8Array | null = null;
  // W38/5 — the SourceRecord.id of a just-folded report, so App can auto-navigate to it.
  let newReportId: string | null = null;
  let dragging = $state(false);

  function reset() {
    status = "idle";
    kind = "report";
    fileName = "";
    errorMsg = "";
    dupOf = null;
    fold = null;
    srcFold = null;
    pending = null;
    bytes = null;
    newReportId = null;
  }

  async function onFile(file: File) {
    if (!client || !clientId) return;
    reset();
    fileName = file.name;
    try {
      status = "reading";
      bytes = new Uint8Array(await file.arrayBuffer());
      // The PDF/non-PDF split is the same predicate classifyUpload branches on below;
      // flipping the status label here (not the classification itself) keeps the
      // "Extracting…" hint visible for the report path's network round-trip.
      if (/\.pdf$/i.test(file.name)) {
        if (!pdfImport) {
          status = "error";
          errorMsg = ABILITY_UNAVAILABLE.documents;
          return;
        }
        status = "extracting";
      }
      const result = await classifyUpload(client, clientId, file);
      switch (result.status) {
        case "duplicate": {
          kind = result.kind;
          const dupSrc = client.sources?.find((s) => s.id === result.existingId);
          const dupPend = client.pendingUploads?.find((p) => p.id === result.existingId);
          status = "duplicate";
          dupOf = dupSrc
            ? { name: dupSrc.originalName, when: dupSrc.importedAt.slice(0, 10) }
            : { name: dupPend!.originalName, when: dupPend!.uploadedAt.slice(0, 10) };
          break;
        }
        case "report":
          kind = "report";
          fold = result.fold;
          newReportId = result.id;
          status = "preview";
          break;
        case "source":
          kind = "source";
          srcFold = result.srcFold;
          status = "preview";
          break;
        case "pending":
          kind = "pending";
          pending = result.pending;
          status = "preview";
          break;
        case "error":
          status = "error";
          errorMsg = result.message;
          break;
      }
    } catch (e) {
      status = "error";
      errorMsg = (e as Error).message || "Could not read this file.";
    }
  }

  async function commit() {
    if (!clientId || !bytes) return;
    const rawFile = kind === "report" ? fold?.storedFile : kind === "source" ? srcFold?.storedFile : pending?.upload.file;
    const next = kind === "report" ? fold?.client : kind === "source" ? srcFold?.client : pending?.client;
    if (!rawFile || !next) return;
    status = "committing";
    try {
      // The page count rides along with the upload: it is what the report corpus checks its ceiling
      // against, and this is the only moment a browser has the bytes open. See CORPUS.md.
      const res = await putRaw(clientId, rawFile, bytes, await countPdfPages(bytes, rawFile));
      if (!res.ok && res.status !== 204) {
        throw new Error(`storing the original failed (${res.status})`);
      }
      await onImported(next, kind === "report" ? newReportId ?? undefined : undefined);
      status = "done";
    } catch (e) {
      status = "error";
      errorMsg = (e as Error).message || "Save failed.";
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  }
  function onInput(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file) onFile(file);
  }

  let a = $derived(fold?.applied);
  let c = $derived(fold?.contribution);
</script>

<div class="import-tab">
  <h2>Import a report</h2>

  {#if !client}
    <p class="lead">Create a record first, then drop a report here to get started.</p>
  {:else}
    <p class="lead">
      Drop a {#if pdfImport}health report (PDF), {/if}lab spreadsheet, or device export to add it to
      <strong>{client.displayName}</strong>'s record.
    </p>
    {#if !pdfImport}<p class="note warn">{ABILITY_UNAVAILABLE.documents}</p>{/if}

    {#if status === "idle" || status === "error" || status === "duplicate"}
      <label
        class="dropzone"
        class:dragging
        ondragover={(e) => { e.preventDefault(); dragging = true; }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
      >
        <input type="file" accept={pdfImport ? "application/pdf,.pdf,.xlsx,.xls" : ".xlsx,.xls"} onchange={onInput} />
        <p class="big">📄</p>
        <p>Drop a file here, or click to choose one.</p>
        <p class="hint">
          {pdfImport ? "PDF reports and lab spreadsheets" : "Lab spreadsheets"} are read instantly; unrecognized formats are queued for processing.
        </p>
      </label>
    {/if}

    {#if status === "reading" || status === "extracting"}
      <div class="working">
        <p><span class="spinner"></span> {status === "reading" ? "Reading" : "Extracting"} <code>{fileName}</code>…</p>
        {#if status === "extracting"}<p class="muted">Reading the report with {PRODUCT_NAME} — this can take a few seconds.</p>{/if}
      </div>
    {/if}

    {#if status === "duplicate"}
      <div class="note dup">
        <strong>Already on file.</strong> <code>{fileName}</code> matches something already imported{#if dupOf} ({dupOf.name}, {dupOf.when}){/if}. Nothing to do.
        <div><button class="secondary" onclick={reset}>Choose another</button></div>
      </div>
    {/if}

    {#if status === "error"}
      <div class="note err">
        <strong>Couldn't import.</strong> {errorMsg}
        <div><button class="secondary" onclick={reset}>Try again</button></div>
      </div>
    {/if}

    {#if status === "preview" && kind === "report" && fold && a && c}
      <div class="preview">
        <h3>{fold.studyType}</h3>
        <ul class="summary">
          <li><strong>Diagnoses:</strong> {a.diseasesAdded} new{#if a.diseasesAdopted}, {a.diseasesAdopted} adopted{/if}{#if a.comorbiditiesMerged}, {a.comorbiditiesMerged} comorbidity code(s) merged{/if}</li>
          <li><strong>Markers:</strong> {a.markersAdded} new{#if a.markersAdopted}, {a.markersAdopted} adopted{/if}</li>
        </ul>
        {#if c.lowConfidence > 0}
          <p class="warn">⚠ {c.lowConfidence} item(s) extracted with low confidence — verify against the report after importing.</p>
        {/if}
        {#if c.priorMismatches.length > 0}
          <p class="warn">⚠ {c.priorMismatches.length} prior value(s) disagree with a reading already on file.</p>
        {/if}
        {#if a.diseasesAdded === 0 && a.diseasesAdopted === 0 && a.markersAdded === 0 && a.markersAdopted === 0}
          <p class="warn">No new findings were extracted from this report.</p>
        {/if}
        <div class="actions">
          <button class="primary" onclick={commit}>Add to {client.displayName}'s record</button>
          <button class="secondary" onclick={reset}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if status === "preview" && kind === "source" && srcFold}
      <div class="preview">
        <h3>{fileName}</h3>
        <ul class="summary">
          <li><strong>Readings:</strong> {srcFold.applied.added} new{#if srcFold.applied.adopted}, {srcFold.applied.adopted} adopted{/if}{#if srcFold.applied.updated}, {srcFold.applied.updated} refreshed{/if} <span class="muted">({srcFold.readingCount} in file)</span></li>
          {#if srcFold.dateStart}<li><strong>Dates:</strong> {srcFold.dateStart}{#if srcFold.dateEnd && srcFold.dateEnd !== srcFold.dateStart} – {srcFold.dateEnd}{/if}</li>{/if}
        </ul>
        {#if srcFold.applied.added === 0 && srcFold.applied.adopted === 0 && srcFold.applied.updated === 0}
          <p class="warn">Every reading in this file is already on record — nothing new to add.</p>
        {/if}
        <div class="actions">
          <button class="primary" onclick={commit}>Add to {client.displayName}'s record</button>
          <button class="secondary" onclick={reset}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if status === "preview" && kind === "pending" && pending}
      <div class="preview">
        <h3>{fileName}</h3>
        <p>This format isn't read in the browser yet. We'll store it and process it into
          {client.displayName}'s record — usually within ~24&nbsp;hours.</p>
        <div class="actions">
          <button class="primary" onclick={commit}>Upload for processing</button>
          <button class="secondary" onclick={reset}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if status === "committing"}
      <div class="working"><p><span class="spinner"></span> {kind === "pending" ? "Uploading" : "Saving"}…</p></div>
    {/if}

    {#if status === "done" && kind === "report"}
      <div class="note ok">
        <strong>Added.</strong> The report and its diagnoses are now in the Health Reports. Downstream {PRODUCT_NAME}
        sections are marked out of date (●) — re-translate when you're ready.
        <div><button class="secondary" onclick={reset}>Import another</button></div>
      </div>
    {/if}

    {#if status === "done" && kind === "source"}
      <div class="note ok">
        <strong>Added.</strong> The readings are now in {client.displayName}'s record. Downstream {PRODUCT_NAME}
        sections are marked out of date (●) — re-translate when you're ready.
        <div><button class="secondary" onclick={reset}>Import another</button></div>
      </div>
    {/if}

    {#if status === "done" && kind === "pending"}
      <div class="note ok">
        <strong>Uploaded.</strong> <code>{fileName}</code> is queued — it shows as <em>Processing</em> in
        Health Reports and will be folded in within ~24&nbsp;hours.
        <div><button class="secondary" onclick={reset}>Import another</button></div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .import-tab { max-width: 46rem; }
  h2 { margin: 0 0 0.4rem; font-size: 1.25rem; }
  h3 { margin: 0 0 0.4rem; font-size: 1.05rem; }
  .lead { color: var(--muted); margin: 0 0 1.5rem; line-height: 1.5; }
  .dropzone {
    display: block;
    border: 2px dashed var(--border);
    border-radius: 12px;
    padding: 2.5rem 1.5rem;
    text-align: center;
    color: var(--fg);
    cursor: pointer;
  }
  .dropzone.dragging { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .dropzone input { display: none; }
  .dropzone .big { font-size: 2.5rem; margin: 0 0 0.5rem; }
  .dropzone .hint { color: var(--muted); font-size: 0.82rem; margin: 0.5rem 0 0; }
  .working { padding: 1.5rem 0.5rem; }
  .working p { margin: 0 0 0.5rem; }
  .muted { color: var(--muted); font-size: 0.9rem; }
  .spinner {
    display: inline-block; width: 0.9em; height: 0.9em; vertical-align: -0.1em;
    border: 2px solid var(--border); border-top-color: var(--fg);
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .note { border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.1rem; line-height: 1.5; }
  .note div { margin-top: 0.7rem; }
  .note.ok { border-color: color-mix(in srgb, var(--safe) 40%, var(--border)); }
  .note.err { border-color: color-mix(in srgb, var(--alert) 45%, var(--border)); }
  .preview { border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.1rem; }
  .preview p { line-height: 1.5; margin: 0.2rem 0 0; }
  .summary { margin: 0.3rem 0 0.6rem; padding-left: 1.1rem; line-height: 1.6; }
  .warn { color: var(--warn); margin: 0.3rem 0; }
  .actions { display: flex; gap: 0.6rem; margin-top: 0.8rem; }
  button { border-radius: 8px; padding: 0.45rem 0.9rem; cursor: pointer; border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
  button.primary { border-color: var(--fg); font-weight: 600; }
  @media print { .import-tab { display: none !important; } }
</style>
