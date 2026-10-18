// Render a PDF's pages to JPEGs, for a model that can see but cannot take a PDF.
//
// Most OpenAI-compatible endpoints (Ollama, vLLM, LM Studio) accept images and refuse a PDF file
// part, so a vision model configured for `extract` or `document` would otherwise be unreachable.
// Rendering is deliberately the only conversion that ships: scraping the text layer loses the
// layout a report's meaning lives in and produces nothing at all from a scan, whereas pages as
// images are what a human reader sees. It happens in the BROWSER because pdfjs does not run on
// the Workers runtime — the same reason the native-PDF path exists at all.
import { openPdf, type PdfDoc } from "@tinytars/frame/pdf-render";
import { MAX_DOCUMENT_PAGES } from "@pablotech/akesi/document-read";
import type { PageImage } from "@pablotech/akesi/report-extract";
import { bytesToBase64 } from "./base64";
import { capsFor, INFERENCE, type Feature, type InferenceConfig } from "./model-config";

// 1568px is the long edge above which Anthropic downsamples anyway, and roughly 150 DPI on a letter
// page — enough for the small print in a lab table, without paying for pixels no model will read.
const PAGE_WIDTH_PX = 1568;
const JPEG_QUALITY = 0.8;

/** True when this feature's model must be sent rendered pages: it can see images, but not take a PDF. */
export function needsPageImages(feature: Feature, config: InferenceConfig = INFERENCE): boolean {
  const caps = capsFor(feature, config);
  return !caps.pdf && caps.vision;
}

export async function renderPdfPages(bytes: Uint8Array): Promise<PageImage[]> {
  // bytes.slice(), NOT bytes: pdf.js TRANSFERS the array it is handed to its worker, detaching the
  // caller's view (attachment-store.ts records what that cost the first time).
  return renderOpenPdfPages(await openPdf(bytes.slice()));
}

/** The same, for a caller that has already opened the document and should not parse it twice. */
export async function renderOpenPdfPages(doc: PdfDoc): Promise<PageImage[]> {
  const canvas = document.createElement("canvas");
  const pages: PageImage[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_DOCUMENT_PAGES); n++) {
    await doc.renderPage(n, canvas, PAGE_WIDTH_PX);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new Error(`could not render page ${n} of this PDF`);
    pages.push({ base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mediaType: "image/jpeg" });
  }
  return pages;
}
