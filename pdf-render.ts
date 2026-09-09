// W46 Phase 5 — lazy pdfjs-dist loader, shared by AttachmentViewer.svelte (the full in-app PDF
// viewer) and PdfThumbnail.svelte (the Reports list's first-page preview). pdfjs-dist (~500 KB)
// is deliberately kept out of the browser fold bundle (ingest-core.ts, parse-raw.ts's comments
// explain why); this dynamic import is the only place in the rendering path that pulls it in, and
// only once a PDF actually needs to be shown as pixels (report-extract.ts's own use of pdfjs is
// CLI-side text extraction, a separate concern).
let pdfjsPromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then(async (pdfjs) => {
      const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

export interface PdfDoc {
  numPages: number;
  renderPage(pageNum: number, canvas: HTMLCanvasElement, maxWidth?: number): Promise<void>;
}

// `source` is either a URL (Reports/AttachmentViewer fetch via /api/raw) or raw bytes.
export async function openPdf(source: string | Uint8Array): Promise<PdfDoc> {
  const pdfjs = await loadPdfjs();
  const params = typeof source === "string" ? { url: source } : { data: source };
  // isEvalSupported:false — same runtime option parsers/report.ts and parsers/dexa.ts already set
  // (missing from the legacy build's DocumentInitParameters typing there too). The url|data union
  // here doesn't structurally match DocumentInitParameters closely enough for a direct `as`, hence
  // the double cast via unknown (same reason TS gives for suggesting it).
  const doc = await pdfjs.getDocument(
    { ...params, isEvalSupported: false } as unknown as Parameters<typeof pdfjs.getDocument>[0],
  ).promise;
  return {
    numPages: doc.numPages,
    async renderPage(pageNum: number, canvas: HTMLCanvasElement, maxWidth = 900) {
      const page = await doc.getPage(pageNum);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = maxWidth / unscaled.width;
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    },
  };
}
