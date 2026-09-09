<script lang="ts">
  import type { Attachment } from "./attachment-types";
  import Modal from "./Modal.svelte";
  import { openPdf, type PdfDoc } from "./pdf-render";

  // W46 Phase 5 — the in-app viewer every attachment click opens (AttachmentStrip.svelte) instead
  // of a bare new-tab link. Images render directly; PDFs render page-by-page onto a <canvas> via
  // the shared lazy pdfjs loader (pdf-render.ts) so the ~500 KB pdfjs bundle only loads when a PDF
  // is actually being viewed. This is the "see -> scroll pages -> Download" path an ER doctor
  // needs, with no menu digging.
  interface Props {
    attachments: Attachment[];
    index: number;
    clientId: string;
    attachmentUrl: (clientId: string, key: string) => string;
    onClose: () => void;
  }
  let { attachments, index = $bindable(), clientId, attachmentUrl, onClose }: Props = $props();

  let current = $derived(attachments[index]);
  let isImage = $derived(current?.mediaType.startsWith("image/") ?? false);
  let isPdf = $derived(current?.mediaType === "application/pdf");

  function go(delta: number) {
    index = Math.max(0, Math.min(attachments.length - 1, index + delta));
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  }

  // PDF page state — reset whenever the current attachment changes.
  let pdfDoc = $state<PdfDoc | null>(null);
  let pdfPage = $state(1);
  let pdfError = $state<string | null>(null);
  let canvasEl = $state<HTMLCanvasElement | undefined>();

  $effect(() => {
    pdfDoc = null;
    pdfPage = 1;
    pdfError = null;
    if (!isPdf || !current) return;
    const url = attachmentUrl(clientId, current.key);
    openPdf(url)
      .then((doc) => { pdfDoc = doc; })
      .catch((e) => { pdfError = e instanceof Error ? e.message : "Couldn't open this PDF."; });
  });

  $effect(() => {
    if (pdfDoc && canvasEl) pdfDoc.renderPage(pdfPage, canvasEl);
  });
</script>

<svelte:window onkeydown={onKeydown} />

<Modal label={current?.name ?? "Attachment"} onClose={onClose} wide>
  <div class="viewer">
    <div class="viewer-head">
      <span class="viewer-name">{current?.name}</span>
      <a class="viewer-download" href={clientId && current ? attachmentUrl(clientId, current.key) : "#"} download={current?.name} target="_blank" rel="noopener">⤓ Download</a>
    </div>
    <div class="viewer-body">
      {#if attachments.length > 1}
        <button type="button" class="viewer-nav prev" disabled={index === 0} onclick={() => go(-1)} aria-label="Previous attachment">‹</button>
      {/if}
      {#if isImage && current}
        <img class="viewer-image" src={attachmentUrl(clientId, current.key)} alt={current.name} />
      {:else if isPdf}
        {#if pdfError}
          <p class="viewer-error">{pdfError}</p>
        {:else if !pdfDoc}
          <p class="viewer-loading">Loading PDF…</p>
        {:else}
          <canvas bind:this={canvasEl}></canvas>
        {/if}
      {:else}
        <p class="viewer-unsupported">No preview available for this file — use Download.</p>
      {/if}
      {#if attachments.length > 1}
        <button type="button" class="viewer-nav next" disabled={index === attachments.length - 1} onclick={() => go(1)} aria-label="Next attachment">›</button>
      {/if}
    </div>
    {#if isPdf && pdfDoc && pdfDoc.numPages > 1}
      <div class="viewer-pages">
        <button type="button" class="btn" disabled={pdfPage <= 1} onclick={() => (pdfPage = Math.max(1, pdfPage - 1))}>‹ Page</button>
        <span>Page {pdfPage} of {pdfDoc.numPages}</span>
        <button type="button" class="btn" disabled={pdfPage >= pdfDoc.numPages} onclick={() => (pdfPage = Math.min(pdfDoc!.numPages, pdfPage + 1))}>Page ›</button>
      </div>
    {/if}
    {#if attachments.length > 1}
      <p class="viewer-count">{index + 1} of {attachments.length}</p>
    {/if}
  </div>
</Modal>

<style>
  .viewer { display: flex; flex-direction: column; gap: 0.75rem; }
  .viewer-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-right: 1.5rem; }
  .viewer-name { font-weight: 600; font-size: 0.92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .viewer-download { font-size: 0.85rem; color: var(--accent); white-space: nowrap; }
  .viewer-body { position: relative; display: flex; align-items: center; justify-content: center; min-height: 300px; }
  .viewer-image { max-width: 100%; max-height: 70vh; object-fit: contain; border-radius: 6px; }
  .viewer-body canvas { max-width: 100%; max-height: 70vh; border: 1px solid var(--border); border-radius: 4px; }
  .viewer-loading, .viewer-error, .viewer-unsupported { color: var(--muted); font-size: 0.9rem; }
  .viewer-error { color: var(--alert); }
  .viewer-nav {
    position: absolute; top: 50%; transform: translateY(-50%); z-index: 1;
    width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--border); background: white;
    font-size: 1.3rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .viewer-nav:disabled { opacity: 0.3; cursor: not-allowed; }
  .viewer-nav.prev { left: -0.5rem; }
  .viewer-nav.next { right: -0.5rem; }
  .viewer-pages { display: flex; align-items: center; justify-content: center; gap: 0.75rem; font-size: 0.85rem; }
  .viewer-count { text-align: center; color: var(--muted); font-size: 0.8rem; margin: 0; }
</style>
